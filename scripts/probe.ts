/**
 * Day-1 probe. Answers, against the live Shannon testnet, the two questions the
 * Abadi design still rests on:
 *
 *   1. Do live event-contract markets exist, and what are their real cadences?
 *   2. Is there a complete-set parity deviation to harvest, or does the venue
 *      mirror Up/Down mechanically so no spread can ever open? SteadyVault's
 *      entire premise is question 2.
 *
 * Read-only. No signer, no writes. Run: node scripts/probe.ts
 */
import { SomniaMarkets, isBinaryMarket } from "@somnia-chain/markets-sdk";
import { defineChain } from "viem";

const RPC = "https://api.infra.testnet.somnia.network";
const WS = "wss://api.infra.testnet.somnia.network/ws";
const INDEXER = "https://dev.smk.somnia.host/v1/graphql";
const VENUE = "0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c";

const shannon = defineChain({
  id: 50312,
  name: "Somnia Shannon",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [RPC], webSocket: [WS] } },
});

const addresses = {
  binaryModule: "0x3ecC694Cef705358864a646142ac17A90E29e388",
  marketsCore: "0x2802504314685D89bF6C992CA5a8e7cC78bc0294",
  binarySettlement: "0xbF4a49e0Dfd092e5FBE8E5761064C49533e6Ed23",
  collateralRouter: "0xbC0C9834B15ACE38bB50dDaa7d7f7C7CC4DC183C",
  oracleHub: "0xe40db387cC98601Dd11bd634fF2f3AD5686dE32b",
  clobFactory: "0xb2BE8EE02F96379DB75f01802384593EBa9bfF04",
  binaryPoolImpl: "0x82A1FcdaA2daC2fC7D5f9909D43E68021eE966FD",
  marketCreator: "0x5Ce69567dB39C8fBAd7e048bEfdbcCdfE67B44e6",
  marketCreatorFactory: "0xE6bEE93cE87c9E6e62aCb621caa7832EE47b4F6B",
  collateral: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E",
  testUsdc: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E",
};

const STATUS = ["Listed", "Trading", "Locked", "3?", "Resolved", "Voided"];
const fmt = (n: unknown) => (n === undefined || n === null ? "  --  " : Number(n).toFixed(4));

async function main() {
  const exchange = new SomniaMarkets({
    indexerUrl: INDEXER,
    chain: shannon,
    wsRpcUrl: WS,
    addresses: addresses as never,
  } as never);

  console.log("chain 50312 | venue", VENUE.slice(0, 12) + "...");
  console.log("");

  const all = Object.values(await exchange.loadMarkets(true));
  const binaries = all.filter((m: any) => isBinaryMarket(m.info));
  console.log(`markets total ${all.length} | binary ${binaries.length}`);
  console.log("");

  if (binaries.length === 0) {
    console.log("NO BINARY MARKETS. Abadi cannot trade what does not exist.");
    console.log("Sample of what IS listed:");
    all.slice(0, 8).forEach((m: any) => console.log("  ", m.symbol, "kind=", m.info?.kind ?? "?"));
    return;
  }

  const now = Date.now() / 1000;
  let parityChecked = 0;
  let deviations = 0;
  let bestBidSum = 0;
  let bestAskSum = 2;
  const intervals = new Set<string>();

  for (const m of binaries.slice(0, 12) as any[]) {
    const info: any = m.info;
    let onchain: any;
    try {
      onchain = await exchange.client.getMarketOnchain(info.marketId);
    } catch (e: any) {
      console.log(`${m.symbol}  on-chain read failed: ${e?.shortMessage ?? e?.message}`);
      continue;
    }
    const secsLeft = Number(info.expiry ?? onchain.expiry ?? 0) - now;
    const up = m.outcomes?.[0]?.symbol;
    const down = m.outcomes?.[1]?.symbol;
    if (info.intervalSec) intervals.add(String(info.intervalSec));

    console.log(
      `${String(m.symbol ?? info.marketId).padEnd(36)} status=${STATUS[onchain.status] ?? onchain.status}` +
        ` interval=${info.intervalSec ?? "?"}s left=${secsLeft > 0 ? Math.round(secsLeft) + "s" : "expired"}`,
    );

    if (onchain.status !== 1 || !up || !down) continue;

    const [bookUp, bookDown] = await Promise.all([
      exchange.fetchOrderBook(up, 5).catch(() => null),
      exchange.fetchOrderBook(down, 5).catch(() => null),
    ]);
    if (!bookUp || !bookDown) {
      console.log("   book read failed");
      continue;
    }

    const bidUp = bookUp.bids[0]?.[0];
    const askUp = bookUp.asks[0]?.[0];
    const bidDown = bookDown.bids[0]?.[0];
    const askDown = bookDown.asks[0]?.[0];

    console.log(
      `   UP  bid ${fmt(bidUp)} ask ${fmt(askUp)}   |   DOWN bid ${fmt(bidDown)} ask ${fmt(askDown)}` +
        `   depth ${bookUp.bids.length}/${bookUp.asks.length}`,
    );

    if (bidUp !== undefined && bidDown !== undefined) {
      const bidSum = bidUp + bidDown; // > 1 => mint a set, sell both, lock the excess
      bestBidSum = Math.max(bestBidSum, bidSum);
      parityChecked++;
      if (bidSum > 1) deviations++;
      console.log(`   bid(UP)+bid(DOWN) = ${bidSum.toFixed(4)} ${bidSum > 1 ? "  <== HARVESTABLE" : ""}`);
    }
    if (askUp !== undefined && askDown !== undefined) {
      const askSum = askUp + askDown; // < 1 => buy both, merge, lock the difference
      bestAskSum = Math.min(bestAskSum, askSum);
      if (askSum < 1) deviations++;
      console.log(`   ask(UP)+ask(DOWN) = ${askSum.toFixed(4)} ${askSum < 1 ? "  <== HARVESTABLE" : ""}`);
    }
  }

  console.log("");
  console.log("--- verdict ---");
  console.log(`intervals seen: ${[...intervals].join(", ") || "none reported"}`);
  console.log(`books compared: ${parityChecked} | harvestable deviations: ${deviations}`);
  console.log(`best bid sum: ${bestBidSum.toFixed(4)} (need > 1)`);
  console.log(`best ask sum: ${bestAskSum === 2 ? "n/a" : bestAskSum.toFixed(4)} (need < 1)`);
  if (parityChecked === 0) {
    console.log("No two-sided book found. Cannot judge parity yet -- the venue may simply be idle.");
  } else if (deviations === 0) {
    console.log("No deviation in this snapshot. Either the book is thin, or Up/Down are");
    console.log("mirrored mechanically -- in which case SteadyVault has no product.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e: any) => {
    console.error("PROBE FAILED:", e?.shortMessage ?? e?.message ?? e);
    process.exit(1);
  });
