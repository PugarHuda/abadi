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
import { shannon, addresses, INDEXER, WS, VENUE, exchange } from "./lib/somnia.ts";

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
