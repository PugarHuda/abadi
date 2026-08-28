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
};

export type Priced = Candidate & {
  theirBid: bigint;
  theirAsk: bigint;
  mid: bigint;
  half: bigint;
  bid: bigint;
  ask: bigint;
  escrow: bigint;
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
export function priceInside(c: Candidate, bid: number, ask: number, minHalf: bigint, size: bigint = SIZE): Priced | null {
  const theirBid = toWei(bid);
  const theirAsk = toWei(ask);
  const mid = ((theirBid + theirAsk) / (2n * TICK)) * TICK; // snap the mid to the grid
  let half = (theirAsk - theirBid) / 2n - INSIDE_TICKS * TICK; // sit inside their quote
  if (half < minHalf) half = minHalf;
  half = (half / TICK) * TICK;

  const ourBid = mid - half;
  const ourAsk = mid + half;
  if (ourBid >= theirAsk || ourAsk <= theirBid) return null;
  if (ourBid <= 0n || ourAsk >= PRICE_ONE) return null;

  // BUY_YES escrows `bid`; BUY_NO is quoted YES-side and escrows (1 - ask).
  const escrow = (size * ourBid) / PRICE_ONE + (size * (PRICE_ONE - ourAsk)) / PRICE_ONE;
  return { ...c, theirBid, theirAsk, mid, half, bid: ourBid, ask: ourAsk, escrow };
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
