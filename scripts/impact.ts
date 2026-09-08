/**
 * What the venue's book looks like with Abadi in it, and what it looks like without.
 *
 * This was written when Abadi was the only submission putting capital into the book. It
 * is not any more — the field went from 13 entries to 31 between 2026-09-02 and the 6th,
 * and HOUSE, DreamVault, TEMPO, HedgePulse and Perennis all quote this venue now. What
 * stays true is narrower and is the reason this script exists: Abadi is the only one that
 * has *measured* what its own quotes did to the book. The README made the claim from day
 * one off a single episode — "the incumbent tightened in response" — which is an anecdote.
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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

/** How long one indexer question may take before it is abandoned and asked again.
 *
 * `fetch` rejects on a refused connection or a response. It does NOT reject when the host
 * accepts the socket and then says nothing, and that is what this indexer does under load:
 * on 2026-09-06 this script sat on a single request for THIRTY MINUTES — one second of CPU
 * in twenty-nine minutes, waiting on a promise that was never going to settle. The retry
 * loop below could not help, because nothing had failed yet.
 *
 * The same bug, with the same cause, once left the dashboard's ledger on "loading" for good
 * (`web/ledger.js`, and see `fetchIn()` there). A timeout is what converts a hang into an
 * error the retry can act on. 20s is generous: these queries legitimately take seconds. */
const ASK_TIMEOUT_MS = 20_000;

/** The indexer answers `upstream request timeout` as plain text under load, so the
 *  response is read as text first: JSON.parse on that produced a stack trace that said
 *  nothing about what had actually happened. */
async function gql<T>(query: string, variables: Record<string, unknown>, tries = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    let text: string;
    try {
      const r = await fetch(INDEXER, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
      });
      text = await r.text();
    } catch (err) {
      // An abort is this script's own timeout firing, not a page failure — same retry as
      // a truncated body. Anything else (DNS, refused) is retried too, then reported.
      if (attempt >= tries) {
        throw new Error(`indexer unreachable after ${tries} tries: ${(err as Error).message}`);
      }
      await new Promise((res) => setTimeout(res, 800 * attempt));
      continue;
    }
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

/** This run takes tens of minutes and used to print nothing at all until it was done.
 *
 * Progress goes to stderr on purpose: stdout is the markdown report and gets redirected
 * into `docs/evidence/`, so anything chatty on stdout would end up quoted as evidence. */
const note = (s: string) => process.stderr.write(s + "\n");

/** Owners whose history could not be read, kept rather than swallowed.
 *
 * This used to be `.catch(() => ({ Order: [] }))`, which cannot tell "this vault never
 * rested an order" from "this query failed". The two produce the same measurement and only
 * one of them is true. This project has published a flattering number twice already for
 * exactly this reason, so a failed owner now makes it to the report and to the exit code. */
const unread: { owner: string; why: string }[] = [];

/** Every order one owner ever rested, paged rather than truncated.
 *
 * The single `limit: 400` this used to send came back with EXACTLY 400 rows, which is what
 * a truncated history looks like from the outside: the number is the cap, not a count.
 * Pages until a short page arrives, so the total is the real one. `offset` rather than a
 * timestamp cursor because several orders share a second here — both legs of a quote are
 * placed together — and a `_lt` cursor on the last timestamp would silently drop the rest
 * of that second. */
async function ordersOf(owner: string): Promise<Pick<Row, "market_id" | "placedAtTimestamp">[]> {
  const rows: Pick<Row, "market_id" | "placedAtTimestamp">[] = [];
  for (let offset = 0; ; offset += LIMIT) {
    const { Order } = await gql<{ Order: Pick<Row, "market_id" | "placedAtTimestamp">[] }>(
      `query O($o: String!, $n: Int!, $k: Int!) {
         Order(where: {owner: {_eq: $o}}, order_by: {placedAtTimestamp: desc}, limit: $n, offset: $k) {
           market_id placedAtTimestamp
         }
       }`,
      { o: owner, n: LIMIT, k: offset },
    );
    rows.push(...Order);
    if (Order.length < LIMIT) return rows;
  }
}

/** Every order this project has ever rested, newest first. */
async function ourOrders(): Promise<Pick<Row, "market_id" | "placedAtTimestamp">[]> {
  // One owner at a time. An `_in` over all twelve vault addresses answers `upstream
  // request timeout` every time; the same rows come back fine asked one address at a time.
  const out: Pick<Row, "market_id" | "placedAtTimestamp">[] = [];
  let i = 0;
  for (const owner of OURS) {
    i++;
    const tag = `owner ${String(i).padStart(2)}/${OURS.size}  ${owner.slice(0, 10)}…`;
    try {
      const rows = await ordersOf(owner);
      out.push(...rows);
      note(`${tag}  ${rows.length} orders`);
    } catch (e: any) {
      const why = String(e?.message ?? e).split("\n")[0];
      unread.push({ owner, why });
      note(`${tag}  UNREAD — ${why}`);
    }
  }
  return out;
}

/** Every order that ever rested on one window, ours and theirs.
 *
 * Paged, with no `order_by`, and both halves of that are measured rather than assumed.
 *
 * Asked bare — no limit at all, which is how this was written — the busiest windows simply
 * never answer. Market `…009a50` returns **HTTP 504, `upstream request timeout`, after 31
 * seconds**, every time. It was therefore never scored: it went into `refused` and the
 * published spread was computed from the windows whose books happened to be small enough
 * to fetch. That is a selection effect on the project's headline claim and it is now said
 * out loud in the report rather than hidden in a bucket.
 *
 * `order_by` is what costs, not the row count. Same market, same limit of 1000:
 *
 *     limit: 1000                                     200 in 2.5s
 *     limit: 1000, offset: 0                          200 in 2.7s
 *     order_by: {placedAtTimestamp: asc}, limit: 1000 504 in 30.9s
 *
 * So the sort is dropped. Nothing here needs it — `touch()` scans every row to find the
 * best bid and ask, and `liveAt()` reads each row's own timestamps.
 *
 * Paging on `offset` without a sort is only safe if the backend's natural order is stable,
 * so that was checked instead of hoped for: page 0 and page 1000 share **zero** rows, and
 * page 0 fetched twice comes back in identical order. The rows are a settled window's
 * history and do not change. `…009a50` has more than 8,000 of them. */
const BOOK_PAGE = 1000;

async function bookOf(marketId: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0; ; offset += BOOK_PAGE) {
    const { Order } = await gql<{ Order: Row[] }>(
      `query B($m: String!, $n: Int!, $k: Int!) {
         Order(where: {market_id: {_eq: $m}}, limit: $n, offset: $k) {
           market_id isBid price fullQuantity owner status placedAtTimestamp lastUpdatedAtTimestamp
         }
       }`,
      { m: marketId, n: BOOK_PAGE, k: offset },
    );
    rows.push(...Order);
    if (Order.length < BOOK_PAGE) return rows;
  }
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

/** Each window's verdict, on disk, written the moment that window lands.
 *
 * The window loop is three hours of sequential indexer queries and the report is only
 * printed after the last one, so a run that dies at window 121 of 146 publishes nothing.
 * That has now happened three times: twice to memory pressure inside an agent session
 * (windows 68 and 86), and once overnight under Task Scheduler, which is the mechanism
 * that was supposed to fix the first two.
 *
 * Resuming is sound here and is not a shortcut. Every question this script asks is
 * read-only against settled history — a window whose market expired days ago has the same
 * order rows today that it had at 02:51 — so a verdict reached yesterday is the same
 * verdict reached now. What is NOT kept is a failed fetch: see the catch below.
 *
 * Delete the file to force a measurement from scratch. */
const CACHE = "docs/evidence/impact.cache.json";
type Verdict = { with_: number; without: number; t: number } | { why: string };
const cache: Record<string, Verdict> = existsSync(CACHE)
  ? JSON.parse(readFileSync(CACHE, "utf8"))
  : {};

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

  /* A vault whose history did not load is not a vault that never quoted, and the spread
   * number below is the headline claim of this whole project. Say it in the report, not
   * just on the terminal, and fail the run. */
  if (unread.length) {
    console.log(`> ⚠ **${unread.length} of ${OURS.size} owners could not be read, so this is`);
    console.log("> a slice of the record and not the record.** Do not publish it.");
    console.log(">");
    for (const u of unread) console.log(`> - \`${u.owner}\` — ${u.why}`);
    console.log("");
    process.exitCode = 1;
  }

  const scored: { market: string; with_: number; without: number; t: number }[] = [];
  const refused = new Map<string, number>();

  let done = 0;
  for (const [market, t] of firstOn) {
    done++;
    const cached = cache[market];
    if (cached) { note(`window ${done}/${firstOn.size}  …${market.slice(-6)}  cached`); continue; }
    note(`window ${done}/${firstOn.size}  …${market.slice(-6)}`);
    try {
      const rows = await bookOf(market);
      // A moment AFTER ours landed, so our own order is in the book being measured.
      const a = touch(rows, t + 1, false);
      const b = touch(rows, t + 1, true);
      cache[market] = !a ? { why: "no two-sided book with us in it" }
        : !b ? { why: "no book at all without us — we were the only quote" }
        : { with_: a.spread, without: b.spread, t };
      writeFileSync(CACHE, JSON.stringify(cache));
    } catch (e: any) {
      // Deliberately NOT cached. A 504 from the indexer is the load of the moment, not a
      // property of the window, and the next run should ask again.
      const why = String(e?.message ?? e).split("\n")[0];
      refused.set(why, (refused.get(why) ?? 0) + 1);
    }
  }

  for (const [market, t] of firstOn) {
    const v = cache[market];
    if (!v) continue;
    if ("why" in v) refused.set(v.why, (refused.get(v.why) ?? 0) + 1);
    else scored.push({ market, with_: v.with_, without: v.without, t });
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
