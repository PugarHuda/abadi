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
import { defineChain } from "viem";
import { readFileSync } from "node:fs";

const RPC = "https://api.infra.testnet.somnia.network";
const WS = "wss://api.infra.testnet.somnia.network/ws";
const INDEXER = "https://dev.smk.somnia.host/v1/graphql";

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

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

async function main() {
  const ex = new SomniaMarkets({
    indexerUrl: INDEXER,
    chain: shannon,
    wsRpcUrl: WS,
    addresses: addresses as never,
    privateKey: env.PRIVATE_KEY,
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
