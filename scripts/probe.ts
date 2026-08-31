/**
 * Day-1 probe. Answers, against the live Shannon testnet, the two questions the
 * Abadi design still rests on:
 *
 *   1. Do live event-contract markets exist, and what are their real cadences?
 *   2. Is there a complete-set parity deviation to harvest, or does the venue
 *      mirror Up/Down mechanically so no spread can ever open? SteadyVault's
 *      entire premise is question 2.
 *
 * And, since 2026-08-31, the question the audit said the vault had never asked:
 *
 *   3. What does the vault itself think these windows are worth, and does the book
 *      agree? One row per live candidate: the book's mid, the model's probability from
 *      the venue's own price feed, the gap between them, and whether the bot would quote.
 *
 * Read-only. No signer, no writes. Run: node scripts/probe.ts
 */
import { SomniaMarkets, isBinaryMarket } from "@somnia-chain/markets-sdk";
import { shannon, addresses, INDEXER, WS, VENUE, exchange } from "./lib/somnia.ts";
import { candidates, hasHeadroom } from "./lib/quoting.ts";
import { fairProbability } from "./lib/fairvalue.ts";

/** Same knobs the bot reads, so this table says what the bot would actually have done. */
const FV_MAX_EDGE = Number(process.env.FV_MAX_EDGE ?? 0.1);
const EDGE = Number(process.env.EDGE ?? 0.08);

/**
 * Question 3. Every live window with enough of itself left to quote, priced twice: once
 * by the incumbent's book and once by N(d2) off the price feed. A row with no model says
 * why — an unreachable or stale feed is a finding, not a blank.
 */
async function fairValueTable(ex: any, all: unknown[]) {
  const cands = candidates(all).filter((c) => hasHeadroom(c));
  console.log("");
  console.log("--- fair value vs the book ---");
  if (cands.length === 0) {
    console.log("no live window has enough of itself left to quote");
    return;
  }
  console.log(
    "market                                tier   left   book mid   fair    edge   sigma  quote?",
  );
  for (const c of cands) {
    const book: any = await ex.fetchOrderBook(c.upSymbol, 3).catch(() => null);
    const bid = book?.bids?.[0]?.[0], ask = book?.asks?.[0]?.[0];
    const head = `${String(c.symbol).padEnd(36)}  ${String(c.intervalSec).padStart(5)}s ${String(Math.round(c.expiry - Date.now() / 1000)).padStart(6)}s`;
    let fv;
    try {
      fv = await fairProbability(c);
    } catch (e: any) {
      const shown = bid === undefined || ask === undefined ? " no book" : ((bid + ask) / 2).toFixed(3).padStart(8);
      console.log(`${head}  ${shown}     NO MODEL: ${String(e?.message ?? e).split("\n")[0]}`);
      continue;
    }
    if (bid === undefined || ask === undefined) {
      console.log(`${head}    no book   ${fv.p.toFixed(3)}      -   ${(fv.vol.sigma * 100).toFixed(0).padStart(4)}%  no (no two-sided book)`);
      continue;
    }
    const mid = (bid + ask) / 2;
    const edge = Math.abs(mid - fv.p);
    const why =
      mid < EDGE || mid > 1 - EDGE ? "no (near-certain)" : edge > FV_MAX_EDGE ? `no (edge > ${FV_MAX_EDGE})` : "YES";
    console.log(
      `${head}  ${mid.toFixed(3).padStart(8)}  ${fv.p.toFixed(3)}  ${edge.toFixed(3)}  ${(fv.vol.sigma * 100).toFixed(0).padStart(4)}%  ${why}`,
    );
    console.log(
      `   spot ${fv.spot.toFixed(2)}  strike ${fv.strike.toFixed(2)} (${fv.strikeSource})  d2 ${fv.d2.toFixed(3)}  sigma over ${fv.vol.returns} M1 returns, lambda ${fv.vol.lambda}, feed ${Math.round(fv.feedAgeMs / 1000)}s old`,
    );
  }
}

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

  await fairValueTable(exchange, all);

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
