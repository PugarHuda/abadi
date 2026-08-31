/**
 * What the venue's book looks like with Abadi in it, and what it looks like without.
 *
 * Every other submission to this hackathon reads the venue, scores it, or wraps it.
 * Abadi is the only one that puts capital into the book, so it is the only one that can
 * be asked whether the book got better. The README has made that claim since day one off
 * a single episode — "the incumbent tightened in response" — which is an anecdote.
 *
 * This is the same claim as a measurement. For every window Abadi has quoted, the
 * venue's indexer still holds every order that ever rested on it, open or cancelled or
 * filled, with the timestamp it was placed and the timestamp it stopped. So the book can
 * be rebuilt at any instant, twice: once with Abadi's orders and once with them removed.
 *
 * The difference between those two spreads is Abadi's contribution to that market, in
 * ticks, at that moment. Nothing is modelled and nothing is self-reported: both books
 * are built from the venue's own rows, and which rows are ours is decided by the `owner`
 * field the venue itself writes.
 *
 * Read-only. `node scripts/impact.ts [--limit N]`
 */
import { readFileSync } from "node:fs";
import { INDEXER } from "./lib/somnia.ts";

const VAULTS: { address: string }[] = JSON.parse(readFileSync("scripts/lib/vaults.json", "utf8"));
const LIVE = readFileSync(".vault-addr", "utf8").trim();
const OURS = new Set([...VAULTS.map((v) => v.address.toLowerCase()), LIVE.toLowerCase()]);

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i === -1 ? null : process.argv[i + 1];
};
const LIMIT = Number(arg("--limit") ?? 400);
/** The venue's price grid: 0.001 at the collateral's six decimals. */
const TICK = 1000;

type Row = {
  market_id: string;
  isBid: boolean;
  price: string;
  fullQuantity: string;
  owner: string;
  status: string;
  placedAtTimestamp: string;
  lastUpdatedAtTimestamp: string;
};

/** The indexer answers `upstream request timeout` as plain text under load, so the
 *  response is read as text first: JSON.parse on that produced a stack trace that said
 *  nothing about what had actually happened. */
async function gql<T>(query: string, variables: Record<string, unknown>, tries = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(INDEXER, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const text = await r.text();
    let j: any;
    try {
      j = JSON.parse(text);
    } catch {
      if (attempt >= tries) throw new Error(`indexer: ${text.slice(0, 80)}`);
      await new Promise((res) => setTimeout(res, 800 * attempt));
      continue;
    }
    if (j.errors) throw new Error(j.errors[0].message);
    return j.data;
  }
}

/** Every order this project has ever rested, newest first. */
async function ourOrders(): Promise<Pick<Row, "market_id" | "placedAtTimestamp">[]> {
  // One owner at a time. An `_in` over all twelve vault addresses answers `upstream
  // request timeout` every time; the same rows come back fine asked one address at a
  // time, and most of those addresses never rested an order at all.
  const out: Pick<Row, "market_id" | "placedAtTimestamp">[] = [];
  for (const owner of OURS) {
    const { Order } = await gql<{ Order: Pick<Row, "market_id" | "placedAtTimestamp">[] }>(
      `query O($o: String!, $n: Int!) {
         Order(where: {owner: {_eq: $o}}, order_by: {placedAtTimestamp: desc}, limit: $n) {
           market_id placedAtTimestamp
         }
       }`,
      { o: owner, n: LIMIT },
    ).catch(() => ({ Order: [] as Pick<Row, "market_id" | "placedAtTimestamp">[] }));
    out.push(...Order);
  }
  return out;
}

/** Every order that ever rested on one window, ours and theirs. */
async function bookOf(marketId: string): Promise<Row[]> {
  const { Order } = await gql<{ Order: Row[] }>(
    `query B($m: String!) {
       Order(where: {market_id: {_eq: $m}}) {
         market_id isBid price fullQuantity owner status placedAtTimestamp lastUpdatedAtTimestamp
       }
     }`,
    { m: marketId },
  );
  return Order;
}

/** Was this order resting at `t`? Open orders have no end; closed ones end when they closed. */
function liveAt(o: Row, t: number): boolean {
  const from = Number(o.placedAtTimestamp);
  if (from > t) return false;
  if (o.status === "Open") return true;
  return Number(o.lastUpdatedAtTimestamp) > t;
}

/** Best bid and ask at `t`, optionally with this project's own orders removed. */
function touch(rows: Row[], t: number, withoutUs: boolean) {
  let bid = -Infinity, ask = Infinity;
  for (const o of rows) {
    if (withoutUs && OURS.has(o.owner.toLowerCase())) continue;
    if (!liveAt(o, t)) continue;
    const p = Number(o.price);
    if (o.isBid) { if (p > bid) bid = p; }
    else if (p < ask) ask = p;
  }
  if (bid === -Infinity || ask === Infinity) return null;
  return { bid, ask, spread: ask - bid };
}

const ticks = (x: number) => x / TICK;

async function main() {
  console.log("# The book with Abadi in it, and without");
  console.log("");

  const ours = await ourOrders();
  // One measurement per window: the instant our first order rested on it. Later quotes on
  // the same window would be sampling the same contribution twice.
  const firstOn = new Map<string, number>();
  for (const o of ours) {
    const t = Number(o.placedAtTimestamp);
    const cur = firstOn.get(o.market_id);
    if (cur === undefined || t < cur) firstOn.set(o.market_id, t);
  }
  console.log(`${ours.length} orders this project has rested, across ${firstOn.size} windows.`);
  console.log("");

  const scored: { market: string; with_: number; without: number; t: number }[] = [];
  const refused = new Map<string, number>();

  for (const [market, t] of firstOn) {
    try {
      const rows = await bookOf(market);
      // A moment AFTER ours landed, so our own order is in the book being measured.
      const a = touch(rows, t + 1, false);
      const b = touch(rows, t + 1, true);
      if (!a) { refused.set("no two-sided book with us in it", (refused.get("no two-sided book with us in it") ?? 0) + 1); continue; }
      if (!b) { refused.set("no book at all without us — we were the only quote", (refused.get("no book at all without us — we were the only quote") ?? 0) + 1); continue; }
      scored.push({ market, with_: a.spread, without: b.spread, t });
    } catch (e: any) {
      const why = String(e?.message ?? e).split("\n")[0];
      refused.set(why, (refused.get(why) ?? 0) + 1);
    }
  }

  if (scored.length === 0) {
    console.log("nothing scoreable:");
    for (const [why, n] of refused) console.log(`  ${n}x  ${why}`);
    return;
  }

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const withUs = mean(scored.map((s) => s.with_));
  const without = mean(scored.map((s) => s.without));
  const tighter = scored.filter((s) => s.with_ < s.without).length;
  const same = scored.filter((s) => s.with_ === s.without).length;

  console.log("## Spread at the moment Abadi's quote landed");
  console.log("");
  console.log("| | windows | mean spread | in ticks |");
  console.log("|---|---|---|---|");
  console.log(`| the book as it was | ${scored.length} | ${(without / 1e6).toFixed(4)} | ${ticks(without).toFixed(1)} |`);
  console.log(`| the book with Abadi in it | ${scored.length} | ${(withUs / 1e6).toFixed(4)} | ${ticks(withUs).toFixed(1)} |`);
  console.log(`| **difference** | | **${((withUs - without) / 1e6).toFixed(4)}** | **${ticks(withUs - without).toFixed(1)}** |`);
  console.log("");
  console.log(
    `Abadi tightened the book on **${tighter} of ${scored.length}** windows, left it unchanged on ${same}, ` +
      `and widened it on ${scored.length - tighter - same}.`,
  );
  console.log("");
  console.log("Widening is not a failure mode here and it is left in rather than filtered out: a");
  console.log("quote resting outside the incumbent's touch does not move the touch, and a maker");
  console.log("that only ever quoted inside would be a maker that never quoted when the spread was");
  console.log("already tight.");

  console.log("");
  console.log("## The widest ten, by how much they tightened");
  console.log("");
  console.log("| window | without Abadi | with Abadi | ticks tighter |");
  console.log("|---|---|---|---|");
  for (const s of scored.slice().sort((a, b) => (a.with_ - a.without) - (b.with_ - b.without)).slice(0, 10)) {
    console.log(
      `| …${s.market.slice(-6)} | ${(s.without / 1e6).toFixed(3)} | ${(s.with_ / 1e6).toFixed(3)} | ${ticks(s.without - s.with_).toFixed(1)} |`,
    );
  }

  if (refused.size) {
    console.log("");
    console.log("Not scored, and why:");
    for (const [why, n] of [...refused].sort((a, b) => b[1] - a[1])) console.log(`  ${n}x  ${why}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
