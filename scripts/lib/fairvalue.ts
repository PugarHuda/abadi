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
 *   - The vol estimator is local. At the default lambda=0.94 on 1-minute bars the half-life
 *     is about 11 minutes, so a 4h window is priced off the last quarter of an hour of
 *     realised movement. On a quiet testnet that reads low and the model gets over-confident.
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

/** RiskMetrics decay on the EWMA. On M1 bars the half-life is ln(0.5)/ln(lambda) ~ 11 bars. */
export const LAMBDA = Number(process.env.FV_LAMBDA ?? 0.94);
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
const feed = new SomniaMarkets({
  indexerUrl: INDEXER,
  chain: shannon,
  wsRpcUrl: WS,
  addresses: addresses as never,
  priceFeed: process.env.PRICE_FEED_URL
    ? { url: process.env.PRICE_FEED_URL, quote: process.env.PRICE_FEED_QUOTE ?? "USDC" }
    : SOMNIA_TESTNET_PRICE_FEED,
} as never);

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

export type Vol = {
  /** Annualised, from M1 log returns. */
  sigma: number;
  /** Usable returns behind it (gap-spanning pairs are dropped, so this is <= candles-1). */
  returns: number;
  lambda: number;
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
async function realisedVol(asset: string): Promise<Vol> {
  const hit = volCache.get(asset);
  if (hit && Date.now() - hit.at < VOL_TTL_MS) return hit.v;

  const candles = await feed.client.fetchPriceCandles(asset, "M1", { limit: VOL_CANDLES });
  const r: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const a = candles[i - 1], b = candles[i];
    if (b.bucketStart - a.bucketStart !== 60) continue; // gap: not a 1-minute return
    if (!(a.close > 0) || !(b.close > 0)) continue;
    r.push(Math.log(b.close / a.close));
  }
  if (r.length < MIN_RETURNS)
    throw new Error(`only ${r.length} usable M1 returns for ${asset}, need ${MIN_RETURNS}`);

  let v = r.reduce((s, x) => s + x * x, 0) / r.length;
  for (const x of r) v = LAMBDA * v + (1 - LAMBDA) * x * x;
  const sigma = Math.sqrt(v * MINUTES_PER_YEAR);
  if (!(sigma > 0)) throw new Error(`${asset} realised vol is zero over the last ${r.length} minutes`);

  const out: Vol = {
    sigma,
    returns: r.length,
    lambda: LAMBDA,
    fromSec: candles[0].bucketStart,
    toSec: candles[candles.length - 1].bucketStart,
  };
  volCache.set(asset, { at: Date.now(), v: out });
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

  const vol = await realisedVol(c.asset);
  const T = secsLeft / YEAR_SEC;
  const den = vol.sigma * Math.sqrt(T);
  if (!(den > 0)) throw new Error(`sigma*sqrt(T) is ${den}`);

  const d2 = (Math.log(spot / strike) - 0.5 * vol.sigma * vol.sigma * T) / den;
  return { asset: c.asset, spot, strike, strikeSource: source, vol, secsLeft, T, d2, p: normCdf(d2), feedAgeMs };
}

/** One line of reasoning for the log. */
export function fmtFair(f: FairValue): string {
  return (
    `fair ${f.p.toFixed(3)}  spot ${f.spot.toFixed(2)} strike ${f.strike.toFixed(2)} ` +
    `(${f.strikeSource})  sigma ${(f.vol.sigma * 100).toFixed(1)}% on ${f.vol.returns} M1 returns ` +
    `(lambda ${f.vol.lambda})  ${Math.round(f.secsLeft)}s left  d2 ${f.d2.toFixed(3)}  feed ${Math.round(f.feedAgeMs / 1000)}s old`
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
  console.log("ok  fairvalue self-check");
}
