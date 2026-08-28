/**
 * Runs the fork suite against the venue as it is right now.
 *
 * test/fork/Venue.fork.t.sol needs a live window and a price inside its book. Neither
 * can be hard-coded — windows expire — so this finds one, prices it with the same
 * function the bot uses, and hands both to forge as environment variables.
 *
 * Run: node scripts/fork-test.ts            (needs an RPC; no key, no transactions)
 */
import { spawnSync } from "node:child_process";
import { exchange, retry, RPC } from "./lib/somnia.ts";
import { candidates, hasHeadroom, priceInside } from "./lib/quoting.ts";

async function main() {
  const ex = exchange();
  const all = Object.values(await retry("loadMarkets", () => ex.loadMarkets(true)));
  // Longest tier first: the fork is a snapshot, but the window must still be trading
  // at the snapshot's block, and a day-long window is not about to expire.
  const cands = candidates(all).filter(hasHeadroom);

  for (const c of cands) {
    const oc: any = await ex.client.getMarketOnchain(c.marketId).catch(() => null);
    if (!oc || oc.status !== 1) continue;
    const book: any = await ex.fetchOrderBook(c.upSymbol, 5).catch(() => null);
    const bid = book?.bids?.[0]?.[0], ask = book?.asks?.[0]?.[0];
    if (bid === undefined || ask === undefined) continue;
    const p = priceInside(c, bid, ask, 2_500n);
    if (!p) continue;

    console.log(`market ${c.symbol}  ${c.marketId}`);
    console.log(`book   ${bid.toFixed(3)} / ${ask.toFixed(3)}   ours ${(Number(p.bid) / 1e6).toFixed(3)} / ${(Number(p.ask) / 1e6).toFixed(3)}`);
    console.log("");

    const r = spawnSync(
      "forge",
      ["test", "--match-path", "test/fork/*", "-vv"],
      {
        stdio: "inherit",
        shell: true,
        env: { ...process.env, FORK_RPC: RPC, FORK_MARKET: c.marketId, FORK_MID: String(p.mid), FORK_HALF: String(p.half) },
      },
    );
    process.exit(r.status ?? 1);
  }
  console.error("no live window with headroom right now — try again in a minute");
  process.exit(2);
}

main().catch((e: any) => {
  console.error("FAILED:", e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
