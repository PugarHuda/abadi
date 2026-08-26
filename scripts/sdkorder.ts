/**
 * Places one post-only order through the SDK's own path.
 *
 * If the SDK succeeds where our direct `placeBinaryOrder` fails, the fault is in our
 * encoding and the SDK's calldata shows exactly where. If the SDK fails the same way,
 * the fault is environmental — account, market state, or venue permissions — and no
 * amount of re-encoding will fix it.
 *
 * Tiny size. Cancels what it places.
 * Run: node scripts/sdkorder.ts
 */
import { SomniaMarkets, isBinaryMarket } from "@somnia-chain/markets-sdk";
import { shannon, addresses, INDEXER, WS, env } from "./lib/somnia.ts";

async function main() {
  const ex = new SomniaMarkets({
    indexerUrl: INDEXER,
    chain: shannon,
    wsRpcUrl: WS,
    addresses: addresses as never,
    privateKey: env().PRIVATE_KEY,
  } as never);

  const all = Object.values(await ex.loadMarkets(true));
  const now = Date.now() / 1000;
  const cands = (all.filter((x: any) => isBinaryMarket(x.info)) as any[])
    .filter((m) => Number(m.info.intervalSec || 0) >= 14400)
    .sort((a, b) => Number(b.info.intervalSec) - Number(a.info.intervalSec));

  for (const m of cands) {
    const oc: any = await ex.client.getMarketOnchain(m.info.marketId);
    if (oc.status !== 1) continue;
    if (Number(m.info.expiry) - now < 3600) continue;

    const up = m.outcomes?.[0]?.symbol;
    const down = m.outcomes?.[1]?.symbol;
    if (!up) continue;
    const book: any = await ex.fetchOrderBook(up, 5).catch(() => null);
    const bid = book?.bids?.[0]?.[0];
    const ask = book?.asks?.[0]?.[0];
    if (bid === undefined || ask === undefined) continue;

    console.log("market :", m.symbol);
    console.log("up/down:", up, "|", down);
    console.log("book   :", bid.toFixed(3), "/", ask.toFixed(3));
    console.log("mine   : buy at", (bid - 0.002).toFixed(3), "(1 tick inside, post-only)");
    console.log("");

    try {
      const order: any = await ex.createOrder(up, "limit", "buy", 1, bid - 0.002, {
        timeInForce: "PO",
      });
      console.log("SDK ACCEPTED");
      console.log("id     :", order.id);
      console.log("status :", order.status);
      const info = order.info ?? {};
      console.log("receipt:", info?.receipt?.status ?? "(none)", info?.receipt?.transactionHash ?? "");
      try {
        await ex.cancelOrder(order.id, up);
        console.log("cancelled");
      } catch (ce: any) {
        console.log("cancel failed:", ce?.shortMessage ?? ce?.message);
      }
    } catch (e: any) {
      const msg = e?.shortMessage ?? e?.message ?? String(e);
      console.log("SDK REJECTED:", msg.split("\n").slice(0, 4).join(" | ").slice(0, 300));
    }
    return;
  }
  console.log("no suitable market");
}

main()
  .then(() => process.exit(0))
  .catch((e: any) => {
    console.error("FAILED:", (e?.shortMessage ?? e?.message ?? String(e)).slice(0, 300));
    process.exit(1);
  });
