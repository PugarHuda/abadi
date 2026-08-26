/**
 * Pulls settled Event Contract history and measures the one thing Conviction's
 * economics depend on: is the venue's implied probability calibrated?
 *
 * Persistence exposure only pays if an asset closes up MORE OFTEN than the market
 * priced it to. If the book is well calibrated, the product's edge is zero before
 * costs. This measures that against real settled outcomes rather than assuming it.
 *
 * Run: node scripts/history.ts
 */
import { SomniaMarkets } from "@somnia-chain/markets-sdk";
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

const TIERS = [60, 300, 900, 3600, 14400, 86400];

async function main() {
  const exchange = new SomniaMarkets({
    indexerUrl: INDEXER,
    chain: shannon,
    wsRpcUrl: WS,
    addresses: addresses as never,
  } as never);

  const client: any = exchange.client;

  console.log("=== settled market counts ===");
  let total = 0;
  try {
    total = await client.countBinaryMarkets({ venueId: VENUE });
    console.log("countBinaryMarkets:", total);
  } catch (e: any) {
    console.log("countBinaryMarkets failed:", e?.message ?? e);
  }

  console.log("");
  console.log("=== one settled row, raw shape ===");
  let sample: any[] = [];
  for (const status of ["Finalized", "Resolved"]) {
    try {
      sample = await client.listPastBinaryMarkets({ venueId: VENUE, status, limit: 3 });
      console.log(`status=${status} -> ${sample.length} rows`);
      if (sample.length) {
        console.log(JSON.stringify(sample[0], null, 1).slice(0, 1200));
        break;
      }
    } catch (e: any) {
      console.log(`status=${status} failed:`, e?.message ?? e);
    }
  }

  if (!sample.length) {
    console.log("No settled history reachable from this indexer. Stop and ask which one to use.");
    return;
  }

  console.log("");
  console.log("=== UP win rate by tier (calibration check) ===");
  console.log("tier      n     UP wins   UP rate   void");

  for (const intervalSec of TIERS) {
    let rows: any[] = [];
    try {
      rows = await client.listPastBinaryMarkets({
        venueId: VENUE,
        status: "Finalized",
        intervalSec,
        limit: 500,
      });
    } catch {
      try {
        rows = await client.listPastBinaryMarkets({ venueId: VENUE, intervalSec, limit: 500 });
      } catch (e: any) {
        console.log(`${String(intervalSec).padEnd(9)} error: ${e?.message ?? e}`);
        continue;
      }
    }
    if (!rows.length) {
      console.log(`${String(intervalSec).padEnd(9)} 0`);
      continue;
    }

    let up = 0;
    let voided = 0;
    for (const r of rows) {
      const w = r.winningOutcome ?? r.winningOutcomeIdx ?? r.outcome;
      if (r.voided === true || w === null || w === undefined) voided++;
      else if (Number(w) === 0 || String(w).toUpperCase() === "UP" || String(w).toUpperCase() === "YES") up++;
    }
    const decided = rows.length - voided;
    const rate = decided ? (up / decided) * 100 : 0;
    console.log(
      `${String(intervalSec).padEnd(9)} ${String(rows.length).padEnd(5)} ${String(up).padEnd(9)} ` +
        `${rate.toFixed(1).padStart(6)}%   ${voided}`,
    );
  }

  console.log("");
  console.log("=== resolution detail on one market ===");
  try {
    const id = sample[0].marketId ?? sample[0].id;
    const res = await client.getMarketResolution(id);
    console.log(JSON.stringify(res, null, 1).slice(0, 900));
  } catch (e: any) {
    console.log("getMarketResolution failed:", e?.message ?? e);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e: any) => {
    console.error("FAILED:", e?.shortMessage ?? e?.message ?? e);
    process.exit(1);
  });
