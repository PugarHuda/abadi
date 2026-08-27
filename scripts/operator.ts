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
import { SomniaMarkets, isBinaryMarket } from "@somnia-chain/markets-sdk";
import { createPublicClient,  createWalletClient, http,  parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { shannon, addresses, INDEXER, WS, RPC, env, PRICE_ONE, TICK } from "./lib/somnia.ts";

const VAULT_ABI = parseAbi([
  "function quote(uint256 slot, bytes32 marketId, uint256 mid, uint256 halfSpread, uint256 size)",
  "function cancelQuote(uint256 slot)",
  "function idleAssets() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function totalEscrowed() view returns (uint256)",
  "function minHalfSpread() view returns (uint256)",
]);

const ONE = PRICE_ONE;
const SIZE = 100_000_000n; // 100 contracts, 6-decimal collateral
const INSIDE_TICKS = 2n; // quote this many ticks inside each side of the incumbent

const toWei = (x: number) => BigInt(Math.round(x * 1000)) * TICK; // 0.727 -> 727000
const fmt = (w: bigint) => (Number(w) / 1e6).toFixed(3);

async function main() {
  const slot = BigInt(process.argv[2] ?? 0);
  const vault = readFileSync(".vault-addr", "utf8").trim() as `0x${string}`;
  const account = privateKeyToAccount(env().PRIVATE_KEY as `0x${string}`);

  const pub = createPublicClient({ chain: shannon, transport: http(RPC) });
  const wallet = createWalletClient({ account, chain: shannon, transport: http(RPC) });
  const ex = new SomniaMarkets({
    indexerUrl: INDEXER,
    chain: shannon,
    wsRpcUrl: WS,
    addresses: addresses as never,
  } as never);

  console.log("vault    :", vault);
  console.log("operator :", account.address);
  const idle = await pub.readContract({ address: vault, abi: VAULT_ABI, functionName: "idleAssets" });
  const minHalf = await pub.readContract({ address: vault, abi: VAULT_ABI, functionName: "minHalfSpread" });
  console.log("idle     :", (Number(idle) / 1e6).toFixed(2), "tUSDC");
  console.log("minHalf  :", fmt(minHalf as bigint));
  console.log("");

  const all = Object.values(await ex.loadMarkets(true));
  const now = Date.now() / 1000;

  // Prefer longer tiers: more headroom, and the book moves less between read and send.
  // SHORTEST=1 flips it, which is how the settle path gets exercised without waiting a
  // day for a window to resolve.
  const shortest = !!process.env.SHORTEST;
  const candidates = (all.filter((x: any) => isBinaryMarket(x.info)) as any[])
    .filter((m) => Number(m.info.intervalSec || 0) >= 900 && Number(m.info.expiry) - now >= 600)
    .sort((a, b) =>
      shortest
        ? Number(a.info.intervalSec) - Number(b.info.intervalSec)
        : Number(b.info.intervalSec) - Number(a.info.intervalSec),
    )
    .slice(0, shortest ? 20 : 6);
  console.log("candidates:", candidates.map((m) => m.symbol).join(", "));
  console.log("");

  for (const m of candidates) {
    const oc: any = await ex.client.getMarketOnchain(m.info.marketId);
    if (oc.status !== 1) continue;

    const interval = Number(m.info.intervalSec || 0);
    const left = Number(m.info.expiry) - now;
    // Headroom is a fraction of the tier, never a fixed number of seconds: the venue
    // runs 60s through 86400s and a flat rule rejects the fast tiers outright.
    if (left < interval * 0.25 || left < 600) continue;

    const up = m.outcomes?.[0]?.symbol;
    if (!up) continue;
    const book: any = await ex.fetchOrderBook(up, 5).catch(() => null);
    const bid = book?.bids?.[0]?.[0];
    const ask = book?.asks?.[0]?.[0];
    if (bid === undefined || ask === undefined) continue;

    const bidW = toWei(bid);
    const askW = toWei(ask);
    const midW = ((bidW + askW) / (2n * TICK)) * TICK; // snap the mid to the grid
    let halfW = (askW - bidW) / 2n - INSIDE_TICKS * TICK; // sit inside their quote
    if (halfW < (minHalf as bigint)) halfW = minHalf as bigint;
    halfW = (halfW / TICK) * TICK;

    const ourBid = midW - halfW;
    const ourAsk = midW + halfW;
    // A POST_ONLY leg that would cross is rejected by the pool, not silently repriced.
    if (ourBid >= askW || ourAsk <= bidW) {
      console.log(`${m.symbol}: computed quote would cross, skipping`);
      continue;
    }

    const escrow = (SIZE * ourBid) / ONE + (SIZE * (ONE - ourAsk)) / ONE;
    if (escrow > (idle as bigint)) {
      console.log(`${m.symbol}: needs ${(Number(escrow) / 1e6).toFixed(2)} tUSDC, idle is short`);
      continue;
    }

    console.log("market   :", m.symbol);
    console.log("marketId :", m.info.marketId);
    console.log("tier     :", interval + "s,", Math.round(left) + "s left");
    console.log(`theirs   : ${fmt(bidW)} / ${fmt(askW)}   spread ${fmt(askW - bidW)}`);
    console.log(`ours     : ${fmt(ourBid)} / ${fmt(ourAsk)}   spread ${fmt(halfW * 2n)}  <-- inside`);
    console.log(`escrow   : ${(Number(escrow) / 1e6).toFixed(2)} tUSDC for ${Number(SIZE) / 1e6} contracts/side`);
    console.log(`           (= size x (1 - spread); a full pair settles at exactly 1)`);
    console.log("");

    try {
      const hash = await wallet.writeContract({
        address: vault,
        abi: VAULT_ABI,
        functionName: "quote",
        args: [slot, m.info.marketId as `0x${string}`, midW, halfW, SIZE],
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
