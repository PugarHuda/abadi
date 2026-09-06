/**
 * The one place a quote is priced. `operator.ts` runs it once; `bot.ts` runs it every
 * cycle. Two copies of this drifted for a day before it was pulled out.
 *
 * Every rule here is the venue's, not ours: prices sit on a 0.001 grid, POST_ONLY legs
 * that would cross are rejected rather than repriced, and headroom is a fraction of the
 * tier because a flat number of seconds refuses the fast tiers outright.
 */
import { isBinaryMarket } from "@somnia-chain/markets-sdk";
import { PRICE_ONE, TICK } from "./somnia.ts";

export const SIZE = 100_000_000n; // 100 contracts, 6-decimal collateral
export const INSIDE_TICKS = 2n; // quote this many ticks inside each side of the incumbent

export const toWei = (x: number) => BigInt(Math.round(x * 1000)) * TICK; // 0.727 -> 727000
export const fmt = (w: bigint) => (Number(w) / 1e6).toFixed(3);

export type Candidate = {
  symbol: string;
  marketId: `0x${string}`;
  intervalSec: number;
  expiry: number;
  upSymbol: string;
  /** Underlying the window resolves against, e.g. "BTC" — the price feed's asset key. */
  asset: string;
  /**
   * The market row's strike, raw. "0" on this venue's rolling up/down series, where the
   * boundary is the opening price rather than a written-down number; see
   * `fairvalue.ts::strikeOf`, which recovers it from the feed at `tradingStart`.
   */
  strike: string;
  /** Unix seconds trading opened — the instant the rolling series takes its strike from. */
  tradingStart: number;
};

export type Priced = Candidate & {
  theirBid: bigint;
  theirAsk: bigint;
  mid: bigint;
  half: bigint;
  bid: bigint;
  ask: bigint;
  escrow: bigint;
  /** Ticks the mid was moved off the incumbent's toward fair value; 0 without a model. */
  skew: bigint;
};

/** Live binary markets with enough of the window left to be worth quoting. */
export function candidates(all: unknown[], opts: { shortest?: boolean; now?: number } = {}): Candidate[] {
  const now = opts.now ?? Date.now() / 1000;
  return (all.filter((x: any) => isBinaryMarket(x.info)) as any[])
    .filter((m) => Number(m.info.intervalSec || 0) >= 900 && Number(m.info.expiry) - now >= 600)
    .filter((m) => m.outcomes?.[0]?.symbol)
    .sort((a, b) =>
      opts.shortest
        ? Number(a.info.intervalSec) - Number(b.info.intervalSec)
        : Number(b.info.intervalSec) - Number(a.info.intervalSec),
    )
    .map((m) => ({
      symbol: m.symbol,
      marketId: m.info.marketId,
      intervalSec: Number(m.info.intervalSec),
      expiry: Number(m.info.expiry),
      upSymbol: m.outcomes[0].symbol,
      asset: String(m.info.asset ?? ""),
      strike: String(m.info.strike ?? "0"),
      tradingStart: Number(m.info.tradingStart ?? 0),
    }));
}

/** Does the window still have room for a quote to rest and fill? */
export function hasHeadroom(c: Candidate, now = Date.now() / 1000): boolean {
  const left = c.expiry - now;
  return left >= c.intervalSec * 0.25 && left >= 600;
}

/**
 * Price a two-sided quote inside the incumbent's. Returns null when the book is empty
 * or when our legs would cross theirs — the pool would reject that anyway, and the
 * point is to earn the spread, never to pay it.
 */
export function priceInside(
  c: Candidate,
  bid: number,
  ask: number,
  minHalf: bigint,
  size: bigint = SIZE,
  fair?: number,
  maxSkewTicks: bigint = 0n,
): Priced | null {
  const theirBid = toWei(bid);
  const theirAsk = toWei(ask);
  let mid = ((theirBid + theirAsk) / (2n * TICK)) * TICK; // snap the mid to the grid
  let half = (theirAsk - theirBid) / 2n - INSIDE_TICKS * TICK; // sit inside their quote
  if (half < minHalf) half = minHalf;
  half = (half / TICK) * TICK;

  // Lean toward our own probability instead of resting symmetrically on theirs, but only
  // by `maxSkewTicks` — a model that has gone wrong must not be able to walk the quote
  // anywhere the incumbent's mid is not. Both legs move together, so `minHalf` and the
  // spread the vault is paid for are untouched, and the cross checks below still gate it.
  let skew = 0n;
  if (fair !== undefined && maxSkewTicks > 0n) {
    const want = (toWei(fair) - mid) / TICK; // ticks, truncated toward the incumbent
    skew = want > maxSkewTicks ? maxSkewTicks : want < -maxSkewTicks ? -maxSkewTicks : want;
    mid += skew * TICK;
  }

  const ourBid = mid - half;
  const ourAsk = mid + half;
  if (ourBid >= theirAsk || ourAsk <= theirBid) return null;
  if (ourBid <= 0n || ourAsk >= PRICE_ONE) return null;

  // BUY_YES escrows `bid`; BUY_NO is quoted YES-side and escrows (1 - ask).
  const escrow = (size * ourBid) / PRICE_ONE + (size * (PRICE_ONE - ourAsk)) / PRICE_ONE;
  return { ...c, theirBid, theirAsk, mid, half, bid: ourBid, ask: ourAsk, escrow, skew };
}

/**
 * How far the book has walked from a resting quote, in ticks. Past a few ticks the quote
 * is dead: nothing will fill it, and if the vault already holds a complete set there is
 * no reason to leave the capital parked until the window resolves.
 */
export function ticksAway(ourMid: bigint, bid: number, ask: number): bigint {
  const theirMid = (toWei(bid) + toWei(ask)) / 2n;
  const d = theirMid > ourMid ? theirMid - ourMid : ourMid - theirMid;
  return d / TICK;
}

// ---- self-check: the money arithmetic, offline. `node scripts/lib/quoting.ts --self-check`
//
// This file prices every quote the vault has ever placed and had no test of any kind. It is
// also where a float would do the most damage, so `toWei` is checked first and by name.
if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/lib/quoting.ts") && process.argv.includes("--self-check")) {
  const ok = (cond: unknown, what: string) => { if (!cond) throw new Error(what); };

  /* 0.05 * 1e6 is 50000.000000000007 in binary floating point, and BigInt() on that throws
     rather than rounding — which is why toWei multiplies the tick count, not the price. */
  ok(toWei(0.05) === 50_000n, "toWei(0.05) must be exactly 50000");
  ok(toWei(0.727) === 727_000n, "toWei(0.727) must be exactly 727000");
  ok(toWei(0.999) === 999_000n, "toWei(0.999) must be exactly 999000");
  ok(fmt(toWei(0.727)) === "0.727", "fmt round-trips a price");

  const c = {
    symbol: "X", marketId: "0x00" as `0x${string}`, intervalSec: 900,
    expiry: 0, upSymbol: "U", asset: "BTC", strike: "0", tradingStart: 0,
  };
  const minHalf = 2_500n;

  // Quoting inside a 3-tick book: our legs must sit strictly within theirs, and the pair
  // of them must still be worth exactly one.
  const p = priceInside(c, 0.742, 0.772, minHalf)!;
  ok(p !== null, "a 30-tick book is quotable");
  ok(p.bid > p.theirBid && p.ask < p.theirAsk, "both legs rest inside the incumbent");
  ok(p.ask - p.bid === 2n * p.half, "the quote is symmetric about its mid");
  ok(p.half >= minHalf, "the half-spread floor holds");
  ok(p.bid % TICK === 0n && p.ask % TICK === 0n, "both legs sit on the venue's grid");

  /* A book tighter than our own floor does NOT get refused, and that is deliberate — it
     was worth writing this assertion the wrong way round once to be sure. On a 1-tick book
     the floor wins and the quote rests OUTSIDE the incumbent's touch, at 0.498/0.502
     against their 0.500/0.501. `impact.ts` states the reasoning: a quote outside the touch
     does not move the touch, and a maker that only ever quoted inside would be a maker that
     never quoted whenever the spread was already tight. What must never happen is crossing,
     and that is the next three checks. */
  const tightBook = priceInside(c, 0.500, 0.501, minHalf)!;
  ok(tightBook !== null, "a 1-tick book still gets a quote");
  ok(tightBook.half === minHalf - (minHalf % TICK), "and it is priced at the floor");
  ok(tightBook.bid < tightBook.theirBid && tightBook.ask > tightBook.theirAsk, "resting outside the touch");
  ok(tightBook.bid < tightBook.ask, "still a two-sided quote");

  // Crossing, and the two ends of the probability axis, are refused outright.
  ok(priceInside(c, 0.999, 1.000, minHalf) === null, "a quote that would sit at or above 1 is refused");
  ok(priceInside(c, 0.000, 0.001, minHalf) === null, "a quote that would sit at or below 0 is refused");

  // Skew is clamped. A model that has gone wrong must not walk the quote off the book.
  const far = priceInside(c, 0.742, 0.772, minHalf, SIZE, 0.10, 3n)!;
  ok(far.skew === -3n, `skew clamps to -3 ticks, got ${far.skew}`);
  const up = priceInside(c, 0.742, 0.772, minHalf, SIZE, 0.99, 3n)!;
  ok(up.skew === 3n, `skew clamps to +3 ticks, got ${up.skew}`);
  const none = priceInside(c, 0.742, 0.772, minHalf, SIZE, 0.757, 0n)!;
  ok(none.skew === 0n, "no skew is applied when the allowance is zero");
  ok(far.ask - far.bid === up.ask - up.bid, "skew moves both legs and never widens the spread");

  // Escrow is what the two legs actually cost: bid on the YES leg, (1 - ask) on the NO leg.
  const want = (SIZE * p.bid) / PRICE_ONE + (SIZE * (PRICE_ONE - p.ask)) / PRICE_ONE;
  ok(p.escrow === want, "escrow is bid + (1 - ask), per contract");
  ok(p.escrow < SIZE, "a two-sided quote always escrows less than the pair is worth");

  // Headroom: the reason a bare `.filter(hasHeadroom)` was a bug is that the second
  // argument is a clock. Pass it explicitly here and check both ends of the rule.
  const now = 1_000_000;
  ok(hasHeadroom({ ...c, intervalSec: 14400, expiry: now + 3601 }, now), "an hour left on a 4h window is fine");
  ok(!hasHeadroom({ ...c, intervalSec: 14400, expiry: now + 3599 }, now), "under a quarter of the tier is not");
  ok(!hasHeadroom({ ...c, intervalSec: 900, expiry: now + 599 }, now), "under ten minutes is never enough");
  ok(hasHeadroom({ ...c, intervalSec: 900, expiry: now + 601 }, now), "ten minutes on a 15m window is");

  ok(ticksAway(750_000n, 0.742, 0.772) === 7n, "ticksAway measures from mid to mid");
  ok(ticksAway(757_000n, 0.742, 0.772) === 0n, "a quote at the book's mid is zero ticks away");

  console.log("ok  quoting self-check");
}
