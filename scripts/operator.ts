/**
 * Abadi operator. Reads the live book and rests a two-sided quote inside the incumbent
 * spread, in one pass — the book moves between a read and a send, and a stale mid makes
 * a POST_ONLY leg cross and get rejected.
 *
 * This key can only steer quotes. Custody lives in the vault: LiquidityVault has no path
 * that lets `operator` move a token out. That is the shape the DreamDEX team confirmed is
 * the only one that works today, because BinaryPool has no operator gate of its own.
 *
 * Run: node scripts/operator.ts [slot]
 */
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { shannon, RPC, env, exchange, retry } from "./lib/somnia.ts";
import { candidates, hasHeadroom, priceInside, SIZE, fmt } from "./lib/quoting.ts";

const VAULT_ABI = parseAbi([
  "function quote(uint256 slot, bytes32 marketId, uint256 mid, uint256 halfSpread, uint256 size)",
  "function idleAssets() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function totalEscrowed() view returns (uint256)",
  "function minHalfSpread() view returns (uint256)",
]);

async function main() {
  const slot = BigInt(process.argv[2] ?? 0);
  const vault = readFileSync(".vault-addr", "utf8").trim() as `0x${string}`;
  const account = privateKeyToAccount(env().PRIVATE_KEY as `0x${string}`);

  const pub = createPublicClient({ chain: shannon, transport: http(RPC) });
  const wallet = createWalletClient({ account, chain: shannon, transport: http(RPC) });
  const ex = exchange();

  console.log("vault    :", vault);
  console.log("operator :", account.address);
  const idle = (await pub.readContract({ address: vault, abi: VAULT_ABI, functionName: "idleAssets" })) as bigint;
  const minHalf = (await pub.readContract({ address: vault, abi: VAULT_ABI, functionName: "minHalfSpread" })) as bigint;
  console.log("idle     :", (Number(idle) / 1e6).toFixed(2), "tUSDC");
  console.log("minHalf  :", fmt(minHalf));
  console.log("");

  const all = Object.values(await retry("loadMarkets", () => ex.loadMarkets(true)));
  // SHORTEST=1 prefers the fast tiers, which is how the settle path gets exercised
  // without waiting a day for a window to resolve.
  const shortest = !!process.env.SHORTEST;
  const cands = candidates(all, { shortest }).slice(0, shortest ? 20 : 6);
  console.log("candidates:", cands.map((m) => m.symbol).join(", "));
  console.log("");

  for (const c of cands) {
    const oc: any = await ex.client.getMarketOnchain(c.marketId);
    if (oc.status !== 1) continue;
    if (!hasHeadroom(c)) continue;

    const book: any = await ex.fetchOrderBook(c.upSymbol, 5).catch(() => null);
    const bid = book?.bids?.[0]?.[0];
    const ask = book?.asks?.[0]?.[0];
    if (bid === undefined || ask === undefined) continue;

    const p = priceInside(c, bid, ask, minHalf);
    if (!p) {
      console.log(`${c.symbol}: computed quote would cross, skipping`);
      continue;
    }
    if (p.escrow > idle) {
      console.log(`${c.symbol}: needs ${(Number(p.escrow) / 1e6).toFixed(2)} tUSDC, idle is short`);
      continue;
    }

    const left = c.expiry - Date.now() / 1000;
    console.log("market   :", c.symbol);
    console.log("marketId :", c.marketId);
    console.log("tier     :", c.intervalSec + "s,", Math.round(left) + "s left");
    console.log(`theirs   : ${fmt(p.theirBid)} / ${fmt(p.theirAsk)}   spread ${fmt(p.theirAsk - p.theirBid)}`);
    console.log(`ours     : ${fmt(p.bid)} / ${fmt(p.ask)}   spread ${fmt(p.half * 2n)}  <-- inside`);
    console.log(`escrow   : ${(Number(p.escrow) / 1e6).toFixed(2)} tUSDC for ${Number(SIZE) / 1e6} contracts/side`);
    console.log(`           (= size x (1 - spread); a full pair settles at exactly 1)`);
    console.log("");

    try {
      const hash = await wallet.writeContract({
        address: vault,
        abi: VAULT_ABI,
        functionName: "quote",
        args: [slot, c.marketId, p.mid, p.half, SIZE],
      });
      const rcpt = await pub.waitForTransactionReceipt({ hash });
      console.log("QUOTED  tx:", hash);
      console.log("status   :", rcpt.status, " gas:", rcpt.gasUsed.toString());

      const esc = await pub.readContract({ address: vault, abi: VAULT_ABI, functionName: "totalEscrowed" });
      const nav = await pub.readContract({ address: vault, abi: VAULT_ABI, functionName: "totalAssets" });
      console.log("escrowed :", (Number(esc) / 1e6).toFixed(2), "tUSDC");
      console.log("NAV      :", (Number(nav) / 1e6).toFixed(2), "tUSDC");
      return;
    } catch (e: any) {
      const msg = e?.shortMessage ?? e?.message ?? String(e);
      console.log("rejected :", msg.split("\n")[0]);
      if (msg.includes("7cf05fcb") || msg.includes("PostOnlyWouldCross")) {
        console.log("           PostOnlyWouldCross — the book moved. Working as intended:");
        console.log("           the vault refuses to pay the spread it exists to collect.");
      }
      console.log("");
    }
  }

  console.log("no market quoted this pass");
}

main()
  .then(() => process.exit(0))
  .catch((e: any) => {
    console.error("FAILED:", e?.shortMessage ?? e?.message ?? e);
    process.exit(1);
  });
