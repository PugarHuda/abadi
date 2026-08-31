/**
 * Did the model beat the book, on windows that have since resolved?
 *
 * Every claim made for `scripts/lib/fairvalue.ts` so far has been a snapshot: the model
 * and the book disagree, and the model is the side with 239 minute bars behind it. That
 * is not evidence. On 2026-08-31 the disagreement turned out to be one-directional — the
 * book sat above the model on every window that had risen and below it on the one that
 * had fallen — which is either the book extrapolating a move it should not, or the model
 * missing something a backward-looking vol estimate cannot see. A snapshot cannot tell
 * those apart. A resolved window can.
 *
 * The venue has finalised thousands of them and the price feed keeps its candle history,
 * so this needs no waiting. For each resolved window this replays what the model WOULD
 * have said at the instant of that market's last trade, using only data that existed at
 * that instant, and scores it against the outcome next to the book's own price at the
 * same instant.
 *
 * The score is Brier — mean (p − outcome)², lower is better — because it is proper: it
 * is minimised only by reporting your true belief, so it cannot be gamed by a forecaster
 * who hedges toward 0.5. Reported next to the calibration table, because one number can
 * hide a model that is confidently wrong in both directions.
 *
 * Read-only, no signer, no writes.
 *
 *   node scripts/backtest.ts                  the tiers the bot quotes
 *   node scripts/backtest.ts --limit 400      more windows, slower
 *   node scripts/backtest.ts --tier 900       one tier
 */
import { SomniaMarkets } from "@somnia-chain/markets-sdk";
import { shannon, addresses, INDEXER, WS, VENUE } from "./lib/somnia.ts";
import { decayFor, digital, ewmaSigma, m1Returns, priceFeedClient, VOL_CANDLES } from "./lib/fairvalue.ts";

/** The tiers `quoting.ts` will actually quote. 60s and 300s are never quoted. */
const TIERS = [900, 3600, 14400, 86400];
const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i === -1 ? null : process.argv[i + 1];
};
const LIMIT = Number(arg("--limit") ?? 200);
const ONLY_TIER = arg("--tier") ? Number(arg("--tier")) : null;
/** Prices are 1e6 on this venue, same as the collateral. */
const PRICE_ONE = 1e6;
/** How many candles back the vol estimate reads, matching the live path. */
const CANDLE_SPAN_SEC = VOL_CANDLES * 60;
/** Concurrency against the indexer. Higher than this and it starts refusing. */
const LANES = 6;

const client: any = new SomniaMarkets({
  indexerUrl: INDEXER,
  chain: shannon,
  wsRpcUrl: WS,
  addresses: addresses as never,
} as never).client;

// The price feed is a different deployment from the markets indexer and needs its own
// config; `priceFeedClient` is the one definition of it, shared with the live path.
const feed = priceFeedClient();

type Scored = {
  symbol: string;
  asset: string;
  tier: number;
  secsLeft: number;
  spot: number;
  strike: number;
  sigma: number;
  model: number;
  book: number;
  /** 1 if the UP/YES side paid, 0 if it did not. */
  y: number;
  /** The instant scored, so a train/test split can be by time rather than by luck. */
  at: number;
};

/** Mean, guarding the empty case so an empty bucket prints a dash rather than NaN. */
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const brier = (rows: Scored[], pick: (r: Scored) => number) =>
  mean(rows.map((r) => (pick(r) - r.y) ** 2));
const pct = (x: number) => (Number.isFinite(x) ? (x * 100).toFixed(1) + "%" : "   -  ");
const num = (x: number, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : "  -   ");

/**
 * The model, replayed at `at` from data that existed at `at`.
 *
 * Every fetch is windowed with `to`, which is the whole point: a candle or a tick from
 * after the instant being scored would be lookahead, and lookahead makes any model look
 * excellent. The strike is read the same way the live path reads it — the feed's first
 * tick at or after tradingStart — so a reconstruction error shows up here too rather than
 * being quietly assumed away.
 */
async function replay(m: any, at: number) {
  const [openTicks, spotTicks, candles] = await Promise.all([
    feed.fetchPriceHistory(m.asset, { from: Number(m.tradingStart), to: Number(m.tradingStart) + 120, limit: 200 }),
    feed.fetchPriceHistory(m.asset, { from: at - 300, to: at, limit: 400 }),
    feed.fetchPriceCandles(m.asset, "M1", { from: at - CANDLE_SPAN_SEC, to: at, limit: VOL_CANDLES }),
  ]);

  // fetchPriceHistory is newest-first, so the LAST row is the oldest in the window (the
  // open) and the FIRST is the newest at or before `at` (the spot).
  const open = openTicks[openTicks.length - 1];
  if (!open) throw new Error("no feed tick at tradingStart");
  const spotTick = spotTicks[0];
  if (!spotTick) throw new Error("no feed tick in the 300s before the trade");

  const strike = m.strike && m.strike !== "0" ? Number(m.strike) / 100 : open.price;
  const spot = spotTick.price;
  if (!(strike > 0 && spot > 0)) throw new Error("non-positive spot or strike");

  const secsLeft = Number(m.expiry) - at;
  if (secsLeft <= 0) throw new Error("last trade was at or after expiry");

  const r = m1Returns(candles);
  if (r.length < 30) throw new Error(`only ${r.length} usable M1 returns before the trade`);
  const sigma = ewmaSigma(r, decayFor(secsLeft).lambda);
  if (!(sigma > 0)) throw new Error("sigma is zero");

  const { p } = digital(spot, strike, secsLeft, sigma);
  return { spot, strike, sigma, secsLeft, p };
}

/** Run `jobs` with a fixed number of lanes, keeping the indexer inside its temper. */
async function pool<T>(jobs: (() => Promise<T>)[]): Promise<T[]> {
  const out: T[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: LANES }, async () => {
      for (let i = next++; i < jobs.length; i = next++) out.push(await jobs[i]());
    }),
  );
  return out;
}

async function main() {
  const tiers = ONLY_TIER ? [ONLY_TIER] : TIERS;
  console.log(`# Backtest — the model against resolved windows`);
  console.log("");
  console.log(`tiers ${tiers.join(", ")}s · up to ${LIMIT} windows per tier · venue ${VENUE.slice(0, 10)}…`);

  const rows: Scored[] = [];
  const refused = new Map<string, number>();

  for (const tier of tiers) {
    // Finalized only: a Resolved-but-not-Finalized row can still have its payout vector
    // move, and a void has no outcome to score against at all. `intervalSec` filters the
    // cadence server-side and `offset` pages the tail, so the sample is not capped at
    // whatever share of one 500-row page happens to be this tier.
    const cand: any[] = [];
    const PAGE = 200;
    for (let offset = 0; cand.length < LIMIT && offset < 5000; offset += PAGE) {
      const page: any[] = await client.listPastBinaryMarkets({
        venueId: VENUE,
        status: "Finalized",
        intervalSec: tier,
        limit: PAGE,
        offset,
      });
      if (page.length === 0) break;
      for (const m of page) {
        if (Number(m.expiry) - Number(m.tradingStart) !== tier) continue;
        if (!(Number(m.tradeCount ?? 0) > 0)) continue;
        if (m.lastPrice == null || m.lastTradeAt == null) continue;
        if (!Array.isArray(m.payoutNumerators) || m.payoutNumerators.length !== 2) continue;
        cand.push(m);
      }
      if (page.length < PAGE) break;
    }
    const take = cand.slice(0, LIMIT);
    if (take.length === 0) {
      console.log(`\n${tier}s: no finalised window with a trade on it`);
      continue;
    }

    const scored = await pool(
      take.map((m) => async (): Promise<Scored | null> => {
        try {
          const at = Number(m.lastTradeAt);
          const rep = await replay(m, at);
          const den = Number(m.payoutDenominator);
          const y = Number(m.payoutNumerators[0]) / den;
          return {
            symbol: m.question ?? m.marketId,
            asset: m.asset,
            tier,
            secsLeft: rep.secsLeft,
            spot: rep.spot,
            strike: rep.strike,
            sigma: rep.sigma,
            model: rep.p,
            book: Number(m.lastPrice) / PRICE_ONE,
            y,
            at,
          };
        } catch (e: any) {
          const why = String(e?.message ?? e).split("\n")[0];
          refused.set(why, (refused.get(why) ?? 0) + 1);
          return null;
        }
      }),
    );
    for (const s of scored) if (s) rows.push(s);
    console.log(`${tier}s: ${cand.length} finalised with a trade, ${scored.filter(Boolean).length} replayed`);
  }

  if (rows.length === 0) {
    console.log("\nnothing scoreable — every candidate was refused:");
    for (const [why, n] of refused) console.log(`  ${n}x  ${why}`);
    return;
  }

  // Which side of `payoutNumerators` is UP is inferred, not assumed: if index 0 is the
  // "closes at or above" outcome then the book's price must be higher on the windows
  // where it paid. If that does not hold, every score below is inverted and worthless,
  // so it is checked rather than trusted.
  const bookWhenPaid = mean(rows.filter((r) => r.y === 1).map((r) => r.book));
  const bookWhenNot = mean(rows.filter((r) => r.y === 0).map((r) => r.book));
  console.log("");
  console.log(`outcome-0 orientation: book averaged ${num(bookWhenPaid, 3)} where it paid and ${num(bookWhenNot, 3)} where it did not`);
  if (!(bookWhenPaid > bookWhenNot))
    throw new Error("payoutNumerators[0] is not the side the book prices — the scoring would be inverted");

  console.log("");
  console.log("## Brier, lower is better");
  console.log("");
  console.log("| set | n | model | book | always 0.5 | base rate |");
  console.log("|---|---|---|---|---|---|");
  const line = (name: string, rs: Scored[]) =>
    console.log(
      `| ${name} | ${rs.length} | ${num(brier(rs, (r) => r.model))} | ${num(brier(rs, (r) => r.book))} | ${num(brier(rs, () => 0.5))} | ${pct(mean(rs.map((r) => r.y)))} |`,
    );
  line("all", rows);
  for (const tier of tiers) {
    const rs = rows.filter((r) => r.tier === tier);
    if (rs.length) line(`${tier}s`, rs);
  }
  for (const asset of [...new Set(rows.map((r) => r.asset))].sort()) {
    const rs = rows.filter((r) => r.asset === asset);
    if (rs.length >= 10) line(asset, rs);
  }

  // The question this script exists for. On every window, the book's disagreement with
  // the model is signed by the direction the underlying had already moved; if the book is
  // extrapolating and wrong, that signed gap should predict nothing.
  console.log("");
  console.log("## Where they disagree, who is right");
  console.log("");
  console.log("| book − model | n | outcome | model said | off by | book said | off by | closer |");
  console.log("|---|---|---|---|---|---|---|---|");
  const bands: [string, (d: number) => boolean][] = [
    ["book ≥ 0.10 above", (d) => d >= 0.1],
    ["0.05 to 0.10 above", (d) => d >= 0.05 && d < 0.1],
    ["within ±0.05", (d) => Math.abs(d) < 0.05],
    ["0.05 to 0.10 below", (d) => d <= -0.05 && d > -0.1],
    ["book ≥ 0.10 below", (d) => d <= -0.1],
  ];
  for (const [name, f] of bands) {
    const rs = rows.filter((r) => f(r.book - r.model));
    if (!rs.length) continue;
    const actual = mean(rs.map((r) => r.y));
    const mp = mean(rs.map((r) => r.model)), bp = mean(rs.map((r) => r.book));
    const me = Math.abs(mp - actual), be = Math.abs(bp - actual);
    console.log(
      `| ${name} | ${rs.length} | ${pct(actual)} | ${num(mp, 3)} | ${num(me, 3)} | ${num(bp, 3)} | ${num(be, 3)} | ${me < be ? "model" : "book"} |`,
    );
  }

  console.log("");
  console.log("## Calibration — of the windows each side priced in this band, how many paid");
  console.log("");
  console.log("| band | n model | model said | paid | n book | book said | paid |");
  console.log("|---|---|---|---|---|---|---|");
  // Stepped on integers: `for (lo = 0; lo < 1; lo += 0.1)` accumulates to 0.9999999999,
  // which is still < 1, and prints an eleventh "1.0-1.1" band that cannot exist.
  for (let k = 0; k < 10; k++) {
    const lo = k / 10, hi = (k + 1) / 10;
    const inb = (p: number) => p >= lo && (k === 9 ? p <= hi : p < hi);
    const m = rows.filter((r) => inb(r.model)), b = rows.filter((r) => inb(r.book));
    if (!m.length && !b.length) continue;
    console.log(
      `| ${lo.toFixed(1)}–${hi.toFixed(1)} | ${m.length} | ${num(mean(m.map((r) => r.model)), 3)} | ${pct(mean(m.map((r) => r.y)))} | ${b.length} | ${num(mean(b.map((r) => r.book)), 3)} | ${pct(mean(b.map((r) => r.y)))} |`,
    );
  }

  // If the model is pulled toward 0.5 exactly where the book is confident, the suspect is
  // sigma: a larger sigma shrinks d2 and drags every probability to the middle. That is a
  // one-parameter hypothesis and the rows already carry every input, so it costs no
  // fetches to test — rescale sigma and re-price the same 1,272 windows.
  //
  // Fitted on the older half and scored on the newer half, because a scale chosen and
  // graded on the same data would be a curve fit dressed as a finding.
  const byTime = [...rows].sort((a, b) => a.at - b.at);
  const cut = Math.floor(byTime.length / 2);
  const train = byTime.slice(0, cut), test = byTime.slice(cut);
  const reprice = (r: Scored, k: number) => digital(r.spot, r.strike, r.secsLeft, r.sigma * k).p;
  const scan: [number, number, number][] = [];
  for (let k = 0.5; k <= 1.51; k += 0.1) {
    scan.push([k, brier(train, (r) => reprice(r, k)), brier(test, (r) => reprice(r, k))]);
  }
  const best = scan.reduce((a, b) => (b[1] < a[1] ? b : a));
  console.log("");
  console.log("## Is sigma biased? Rescale it and re-price the same windows");
  console.log("");
  console.log(`| sigma x | Brier, train (n=${train.length}) | Brier, test (n=${test.length}) |`);
  console.log("|---|---|---|");
  for (const [k, tr, te] of scan) console.log(`| ${k.toFixed(1)} | ${num(tr)} | ${num(te)}${k === best[0] ? "  <- best on train" : ""} |`);
  console.log("");
  console.log(
    `Best on the older half is x${best[0].toFixed(1)}, which scores ${num(best[2])} on the newer half ` +
      `against ${num(brier(test, (r) => r.model))} unscaled and the book's ${num(brier(test, (r) => r.book))}.`,
  );

  const mb = brier(rows, (r) => r.model), bb = brier(rows, (r) => r.book);
  console.log("");
  console.log("## Verdict");
  console.log("");
  // A margin, because "lower" is not "better". The sigma scan moves Brier by less than
  // 0.005 across a 3x range of the model's single most important input, so anything
  // inside that is smaller than the model's own parameter noise and must not be reported
  // as one side winning. Without this the script called a 0.0003 gap a victory.
  const TIE = 0.005;
  console.log(
    Math.abs(mb - bb) < TIE
      ? `Over ${rows.length} resolved windows the model scores ${num(mb)} and the book ${num(bb)}. That gap is ${num(Math.abs(mb - bb))}, smaller than the ${TIE} this sample can resolve — **the model does not forecast better than the book, and it does not forecast worse. It ties.** Its value is in the refusal and the calibration, not in an edge.`
      : mb < bb
        ? `The model scores ${num(mb)} against the book's ${num(bb)} over ${rows.length} resolved windows — better by ${num(bb - mb)}, outside the ${TIE} tie band.`
        : `The book scores ${num(bb)} against the model's ${num(mb)} over ${rows.length} resolved windows — **the book is the better forecast**, and a filter that refuses where they disagree is refusing the book's information, not avoiding its mistakes.`,
  );
  console.log(`Evaluated at each market's last trade, median ${Math.round(median(rows.map((r) => r.secsLeft)))}s before expiry.`);
  if (refused.size) {
    console.log("");
    console.log("Refused, and why:");
    for (const [why, n] of [...refused].sort((a, b) => b[1] - a[1])) console.log(`  ${n}x  ${why}`);
  }
}

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
