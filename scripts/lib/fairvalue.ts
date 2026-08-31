/**
 * The vault's own opinion of what a window is worth.
 *
 * Until this file existed, `priceInside` derived every number it produced from the
 * incumbent's own bid and ask and then shaved two ticks off their spread. That is not a
 * quote, it is an echo with a discount attached: when the incumbent is stale, Abadi is
 * stale AND two ticks closer to the money, which is the definition of adverse selection.
 * 20% of filled quotes went one-sided on a strategy that breaks even near 9%.
 *
 * A DreamDEX event contract is a digital call. "BTC closes at or above its opening price"
 * pays 1 if S_T >= K and 0 otherwise, so under the usual lognormal assumption
 *
 *     S_T = S * exp(-sigma^2*T/2 + sigma*sqrt(T)*Z),   Z ~ N(0,1)
 *     P(S_T >= K) = N( (ln(S/K) - sigma^2*T/2) / (sigma*sqrt(T)) ) = N(d2)
 *
 * — the Black-Scholes digital, with the drift left at zero because over the 15 minutes to
 * 4 hours these windows run, any real drift is far inside the estimation error on sigma.
 *
 * Every input comes from the venue's own price-feed plane, which this project shipped
 * against for five days without ever calling:
 *
 *   spot    `listPriceFeeds` — the Feed catalog row, plus the `updatedAtMs` that says
 *           whether the oracle is still writing. A stale feed is not a cheap model, it is
 *           no model, and this module refuses to return one.
 *   strike  the market record's `strike` when it carries one; for this venue's rolling
 *           up/down series it is 0 on chain (see strikeOf) and is recovered from the feed
 *           tick at `tradingStart`.
 *   T       `expiry - now`, over a 365-day year.
 *   sigma   EWMA of log returns of M1 candle closes from `fetchPriceCandles`.
 *
 * LIMITS, because a model that is wrong and trusted is worse than no model:
 *   - Lognormal with zero drift. Crypto minute bars are fat-tailed; N(d2) understates the
 *     tails, so the model is most wrong exactly where the payoff is most binary.
 *   - The vol estimator now matches its horizon (see decayFor) rather than reading the
 *     last eleven minutes for every window, but it is still backward-looking realised
 *     vol off 240 minute bars of a testnet oracle: no jump term, no fat tail, no implied
 *     vol to check itself against. On a quiet stretch it reads low and the model gets
 *     over-confident, and the three-tick skew cap is what stops that reaching the quote.
 *   - The strike for the rolling series is the feed's first tick at or after `tradingStart`.
 *     That is what the venue's own fixed-strike markets record at the same instant (proved
 *     in docs/evidence/fair-value-2026-08-31.md), but it is a reconstruction, not a read of
 *     the number the market will settle against.
 *
 * Self-check: `node scripts/lib/fairvalue.ts --self-check` (offline, no network).
 */
import { SomniaMarkets, SOMNIA_TESTNET_PRICE_FEED } from "@somnia-chain/markets-sdk";
import type { PriceFeedInfo } from "@somnia-chain/markets-sdk";
import { shannon, addresses, INDEXER, WS } from "./somnia.ts";
import type { Candidate } from "./quoting.ts";

/**
 * RiskMetrics' 0.94 is a decay for forecasting *tomorrow* from daily bars. Used on M1
 * bars it has a half-life of ln(0.5)/ln(0.94) ~ 11 minutes, and on 2026-08-31 that showed
 * up in production exactly as the arithmetic says it must: BTC's sigma read 64.8% at
 * 09:13Z and 34.6% at 09:52Z, and the fair value of the same 4h window moved from 0.674
 * to 0.818 on that alone. Forecasting four hours of variance from the last eleven minutes
 * of it is not a tuning choice, it is the wrong horizon.
 *
 * So the decay is derived from the window instead of fixed: half-life in bars = minutes
 * to expiry, floored so a 15m window still has a usable sample behind it and capped at
 * half the candles pulled, past which the estimate is the equal-weight sample anyway.
 * `FV_LAMBDA` still overrides, for reproducing an old run.
 */
export const LAMBDA_OVERRIDE = process.env.FV_LAMBDA ? Number(process.env.FV_LAMBDA) : null;
/** Below this the sample behind the estimate is too short to say anything. */
const MIN_HALF_LIFE_BARS = 15;

/** Half-life in M1 bars for a window with `secsLeft` to run, and the decay that gives it. */
export function decayFor(secsLeft: number): { halfLifeBars: number; lambda: number } {
  const halfLifeBars = Math.min(Math.max(secsLeft / 60, MIN_HALF_LIFE_BARS), VOL_CANDLES / 2);
  return {
    halfLifeBars,
    lambda: LAMBDA_OVERRIDE ?? Math.pow(0.5, 1 / halfLifeBars),
  };
}
/** M1 candles pulled per vol estimate. 240 = the last four hours. */
export const VOL_CANDLES = Number(process.env.FV_VOL_CANDLES ?? 240);
/** Beyond this the oracle has stopped writing and its price is not an input to anything. */
export const MAX_FEED_AGE_MS = Number(process.env.FV_MAX_FEED_AGE ?? 120) * 1000;
/** Fewer usable returns than this and the estimate is noise wearing a number's clothes. */
const MIN_RETURNS = 30;
/** 365 days. Matches MINUTES_PER_YEAR below — the two must annualise the same year. */
const YEAR_SEC = 365 * 24 * 3600;
const MINUTES_PER_YEAR = YEAR_SEC / 60;

/**
 * The strike on this venue's market rows is `77520.26 -> "7752026"`, i.e. 1e2. That is
 * inferred from the question text of the venue's fixed-strike series, not from a
 * documented constant, so `fairProbability` sanity-checks the result against spot rather
 * than trusting the scale blind.
 */
const STRIKE_SCALE = 100;

/**
 * A second client, because `exchange()` in somnia.ts carries no `priceFeed` config and
 * every script shares it. Price-feed reads are auth-free and hit a different deployment
 * from the markets indexer, so this costs one object and no credentials.
 */
export function priceFeedClient(): any {
  return new SomniaMarkets({
    indexerUrl: INDEXER,
    chain: shannon,
    wsRpcUrl: WS,
    addresses: addresses as never,
    priceFeed: process.env.PRICE_FEED_URL
      ? { url: process.env.PRICE_FEED_URL, quote: process.env.PRICE_FEED_QUOTE ?? "USDC" }
      : SOMNIA_TESTNET_PRICE_FEED,
  } as never).client;
}
const feed = { client: priceFeedClient() };

/** Standard normal CDF via Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7). */
export function normCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

/**
 * Log returns from M1 candle closes, dropping any pair that spans a missing minute: the
 * feed does skip, and a 3-minute move counted as a 1-minute return inflates sigma by √3.
 */
export function m1Returns(candles: { bucketStart: number; close: number }[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const a = candles[i - 1], b = candles[i];
    if (b.bucketStart - a.bucketStart !== 60) continue;
    if (!(a.close > 0) || !(b.close > 0)) continue;
    r.push(Math.log(b.close / a.close));
  }
  return r;
}

/** EWMA of squared returns seeded on the sample second moment, annualised off M1 bars. */
export function ewmaSigma(returns: number[], lambda: number): number {
  let v = returns.reduce((s, x) => s + x * x, 0) / returns.length;
  for (const x of returns) v = lambda * v + (1 - lambda) * x * x;
  return Math.sqrt(v * MINUTES_PER_YEAR);
}

/**
 * P(S_T >= K) under lognormal, zero drift — the closed form, isolated from where its
 * inputs came from so a backtest can feed it historical ones and get exactly what the
 * live path would have produced at that instant.
 */
export function digital(spot: number, strike: number, secsLeft: number, sigma: number) {
  const T = secsLeft / YEAR_SEC;
  const den = sigma * Math.sqrt(T);
  if (!(den > 0)) throw new Error(`sigma*sqrt(T) is ${den}`);
  const d2 = (Math.log(spot / strike) - 0.5 * sigma * sigma * T) / den;
  return { T, d2, p: normCdf(d2) };
}

export type Vol = {
  /** Annualised, from M1 log returns. */
  sigma: number;
  /** Usable returns behind it (gap-spanning pairs are dropped, so this is <= candles-1). */
  returns: number;
  lambda: number;
  /** The EWMA's half-life in M1 bars, which is the window's own length (see decayFor). */
  halfLifeBars: number;
  fromSec: number;
  toSec: number;
};

export type FairValue = {
  asset: string;
  spot: number;
  strike: number;
  /** How the strike was obtained — the market record, or the feed tick at tradingStart. */
  strikeSource: string;
  vol: Vol;
  secsLeft: number;
  /** Years to expiry. */
  T: number;
  d2: number;
  /** P(underlying at or above strike at expiry) = P(YES). */
  p: number;
  /** How old the feed's latest write was when this was computed, ms. */
  feedAgeMs: number;
};

// ---- caches. One cycle quotes several windows on two assets; none of this needs re-reading
// per market, and the price feed is a shared testnet service.

let feeds: { at: number; rows: Map<string, PriceFeedInfo> } | null = null;
const volCache = new Map<string, { at: number; v: Vol }>();
const strikeCache = new Map<string, { strike: number; source: string }>();
const FEED_TTL_MS = 10_000;
const VOL_TTL_MS = 60_000;

/** The whole feed catalog in one request — spot and freshness for every tracked asset. */
async function feedInfo(asset: string): Promise<PriceFeedInfo> {
  if (!feeds || Date.now() - feeds.at > FEED_TTL_MS) {
    const rows = await feed.client.listPriceFeeds();
    feeds = { at: Date.now(), rows: new Map(rows.map((f: PriceFeedInfo) => [f.asset, f])) };
  }
  const row = feeds.rows.get(asset.toUpperCase());
  if (!row) throw new Error(`price feed tracks no asset "${asset}"`);
  return row;
}

/**
 * Realised volatility, EWMA of log returns on M1 closes: v_t = lambda*v_{t-1} + (1-lambda)*r_t^2,
 * seeded with the sample second moment of the window (returns at this horizon are
 * zero-mean to well inside the error, so no mean is subtracted). Annualised by
 * sqrt(525,600) — minutes in a 365-day year.
 *
 * Returns that span a missing candle are dropped rather than kept: the feed does skip
 * minutes, and a 3-minute move counted as a 1-minute return inflates sigma by sqrt(3).
 */
async function realisedVol(asset: string, secsLeft: number): Promise<Vol> {
  const { halfLifeBars, lambda } = decayFor(secsLeft);
  // Two windows of different lengths on the same asset get different sigmas now, so the
  // key has to carry the horizon or the 4h estimate would be served to the 15m one.
  const key = `${asset}|${halfLifeBars.toFixed(1)}`;
  const hit = volCache.get(key);
  if (hit && Date.now() - hit.at < VOL_TTL_MS) return hit.v;

  const candles = await feed.client.fetchPriceCandles(asset, "M1", { limit: VOL_CANDLES });
  const r = m1Returns(candles);
  if (r.length < MIN_RETURNS)
    throw new Error(`only ${r.length} usable M1 returns for ${asset}, need ${MIN_RETURNS}`);

  const sigma = ewmaSigma(r, lambda);
  if (!(sigma > 0)) throw new Error(`${asset} realised vol is zero over the last ${r.length} minutes`);

  const out: Vol = {
    sigma,
    returns: r.length,
    lambda,
    halfLifeBars,
    fromSec: candles[0].bucketStart,
    toSec: candles[candles.length - 1].bucketStart,
  };
  volCache.set(key, { at: Date.now(), v: out });
  return out;
}

/**
 * The boundary the window resolves against.
 *
 * Two shapes exist on Shannon. The `Pricefeed test:` series carries a real strike on its
 * market row ("will BTC/USDC's price be at or above 77520.26" <=> `strike: "7752026"`).
 * This venue's own series — every window Abadi has ever quoted — asks "BTC closes at or
 * above its OPENING price" and carries `strike: "0"`: the boundary is not written down
 * anywhere, it is whatever the feed read at `tradingStart`.
 *
 * So it is read back from the feed's tick tape at that instant. This is checkable rather
 * than assumed: at 1788150600 the feed's first tick was 77505.05 and the venue's own
 * fixed-strike 300s window opened at that second recorded `strike: "7750505"`. Same number.
 */
async function strikeOf(c: Candidate): Promise<{ strike: number; source: string }> {
  if (c.strike && c.strike !== "0") {
    return { strike: Number(c.strike) / STRIKE_SCALE, source: `market record ${c.strike}/1e2` };
  }
  const hit = strikeCache.get(c.marketId);
  if (hit) return hit;

  // Newest-first, so the LAST row is the oldest tick at or after tradingStart. The window
  // is 120s against a ~1/s feed, comfortably inside the 200-row limit.
  const ticks = await feed.client.fetchPriceHistory(c.asset, {
    from: c.tradingStart,
    to: c.tradingStart + 120,
    limit: 200,
  });
  const open = ticks[ticks.length - 1];
  if (!open)
    throw new Error(`no feed tick within 120s of tradingStart ${c.tradingStart} for ${c.asset}`);
  const out = {
    strike: open.price,
    source: `feed tick at tradingStart+${open.blockTimestamp - c.tradingStart}s`,
  };
  strikeCache.set(c.marketId, out); // fixed for the life of the window
  return out;
}

/**
 * Fair P(YES) for one window, with every input it used so the caller can log its
 * reasoning rather than a bare number.
 *
 * Throws — it never returns a number it does not stand behind. The caller decides what a
 * missing model means; in `bot.ts` it means quoting on the book alone and saying so.
 */
export async function fairProbability(c: Candidate, now = Date.now() / 1000): Promise<FairValue> {
  const info = await feedInfo(c.asset);
  if (!info.latest) throw new Error(`price feed has no observation for ${c.asset} yet`);
  const feedAgeMs = info.updatedAtMs === null ? Number.POSITIVE_INFINITY : Date.now() - info.updatedAtMs;
  if (!(feedAgeMs <= MAX_FEED_AGE_MS))
    throw new Error(
      `${c.asset} feed last written ${Math.round(feedAgeMs / 1000)}s ago, over the ${MAX_FEED_AGE_MS / 1000}s limit`,
    );
  const spot = info.latest.price;
  if (!(spot > 0)) throw new Error(`${c.asset} feed reports spot ${spot}`);

  const secsLeft = c.expiry - now;
  if (secsLeft <= 0) throw new Error(`window expired ${Math.round(-secsLeft)}s ago`);

  const { strike, source } = await strikeOf(c);
  if (!(strike > 0)) throw new Error(`${c.asset} strike resolved to ${strike}`);
  // A scale misread would show up here and nowhere else, and it would produce a confident
  // 0.000 or 1.000 rather than an obvious error. 10x either way is not a market.
  if (strike > spot * 10 || strike * 10 < spot)
    throw new Error(`strike ${strike} vs spot ${spot} — off by more than 10x, refusing the scale`);

  const vol = await realisedVol(c.asset, secsLeft);
  const { T, d2, p } = digital(spot, strike, secsLeft, vol.sigma);
  return { asset: c.asset, spot, strike, strikeSource: source, vol, secsLeft, T, d2, p, feedAgeMs };
}

/** One line of reasoning for the log. */
export function fmtFair(f: FairValue): string {
  return (
    `fair ${f.p.toFixed(3)}  spot ${f.spot.toFixed(2)} strike ${f.strike.toFixed(2)} ` +
    `(${f.strikeSource})  sigma ${(f.vol.sigma * 100).toFixed(1)}% on ${f.vol.returns} M1 returns ` +
    `(half-life ${f.vol.halfLifeBars.toFixed(0)}m, lambda ${f.vol.lambda.toFixed(4)})  ` +
    `${Math.round(f.secsLeft)}s left  d2 ${f.d2.toFixed(3)}  feed ${Math.round(f.feedAgeMs / 1000)}s old`
  );
}

// ---- self-check: the closed form and the CDF, offline. `node scripts/lib/fairvalue.ts --self-check`
if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/lib/fairvalue.ts") && process.argv.includes("--self-check")) {
  const near = (a: number, b: number, eps: number, what: string) => {
    if (Math.abs(a - b) > eps) throw new Error(`${what}: ${a} != ${b} (+-${eps})`);
    console.log(`ok  ${what}  ${a.toFixed(6)}`);
  };
  near(normCdf(0), 0.5, 1e-9, "N(0)");
  near(normCdf(1.959964), 0.975, 1e-6, "N(1.96)");
  near(normCdf(-1.959964), 0.025, 1e-6, "N(-1.96)");
  near(normCdf(-1) + normCdf(1), 1, 1e-9, "N(-z)+N(z)");
  near(normCdf(6), 1, 1e-6, "N(6)");
  // At the money, 4h, 60% annual vol: d2 = -sigma*sqrt(T)/2, a hair under a coin flip.
  const T = 14400 / YEAR_SEC, sigma = 0.6;
  const d2 = (Math.log(1) - 0.5 * sigma * sigma * T) / (sigma * Math.sqrt(T));
  near(normCdf(d2), 0.5 - 0.5 * sigma * Math.sqrt(T) * 0.3989, 1e-4, "ATM 4h digital ~ 0.5");
  // Monotone in spot, and 1% in the money on a 4h window at 60% vol is worth well over
  // the flip while its mirror is worth well under. The two do NOT sum to exactly 1 — the
  // -sigma^2*T/2 term is a real asymmetry, and it is worth about 4e-3 here.
  const up = (m: number) => normCdf((Math.log(m) - 0.5 * sigma * sigma * T) / (sigma * Math.sqrt(T)));
  if (!(up(1.02) > up(1.01) && up(1.01) > up(1) && up(1) > up(1 / 1.01)))
    throw new Error("digital is not monotone in spot");
  if (!(up(1.01) > 0.7)) throw new Error(`1% ITM 4h should be well over 0.7, got ${up(1.01)}`);
  if (!(up(1 / 1.01) < 0.3)) throw new Error(`1% OTM 4h should be well under 0.3, got ${up(1 / 1.01)}`);
  near(up(1.01) + up(1 / 1.01), 1, 5e-3, "near-symmetry about the strike (drift term aside)");

  // The decay is a forecast horizon, so it has to answer to the window, and the numbers
  // below are the ones the bot actually uses: 15m, 1h, 4h and a day.
  const hl = (s: number) => decayFor(s).halfLifeBars;
  if (!(hl(900) === MIN_HALF_LIFE_BARS)) throw new Error(`15m window should floor at ${MIN_HALF_LIFE_BARS}m, got ${hl(900)}`);
  if (!(hl(3600) === 60)) throw new Error(`1h window wants a 60m half-life, got ${hl(3600)}`);
  if (!(hl(14400) === VOL_CANDLES / 2)) throw new Error(`4h window should cap at ${VOL_CANDLES / 2}m, got ${hl(14400)}`);
  if (!(hl(86400) === VOL_CANDLES / 2)) throw new Error("a day must cap at the same place as 4h");
  for (const s of [900, 3600, 14400]) {
    const { halfLifeBars, lambda } = decayFor(s);
    near(Math.pow(lambda, halfLifeBars), 0.5, 1e-12, `lambda^half-life = 1/2 at ${s}s`);
  }
  if (!(decayFor(3600).lambda > decayFor(900).lambda)) throw new Error("a longer window must decay slower");

  // The point of the change, as an assertion: a burst of volatility in the last ten
  // minutes must move the 15m estimate far more than the 4h one. Same series, one quiet
  // hour then ten loud minutes; EWMA seeded on the sample second moment, as above.
  const quiet = Array(230).fill(0.0002), loud = Array(10).fill(0.004);
  const series = [...quiet, ...loud];
  const est = (secs: number) => {
    const { lambda } = decayFor(secs);
    let v = series.reduce((s, x) => s + x * x, 0) / series.length;
    for (const x of series) v = lambda * v + (1 - lambda) * x * x;
    return Math.sqrt(v * MINUTES_PER_YEAR);
  };
  const fast = est(900), slow = est(14400);
  if (!(fast > slow * 1.5))
    throw new Error(`the burst should dominate the short horizon and not the long one: 15m ${fast}, 4h ${slow}`);
  console.log(`ok  burst moves 15m to ${(fast * 100).toFixed(0)}% and 4h only to ${(slow * 100).toFixed(0)}%`);
  console.log("ok  fairvalue self-check");
}
