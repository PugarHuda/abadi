/**
 * Verifies the escrow semantics LiquidityVault's accounting depends on.
 *
 * The claim in the docs is that you can "quote both sides with zero inventory": a Buy Up
 * crossing a Buy Down makes the pool mint a fresh pair. Since `placeOrder` has no outcome
 * argument, a Buy Down must be expressed as a Sell Up at the mirrored price — which means
 * a sell must be placeable WITHOUT owning Up tokens, escrowing collateral instead.
 *
 * If that is true, `getAutoPullRequirement(owner, isBid=false, price, qty)` returns
 * collateral of about (1 - price) * qty, and a two-sided quote costs (1 - spread) per
 * contract pair. If it returns the outcome token instead, zero-inventory quoting is a
 * myth and LiquidityVault must mint complete sets first.
 *
 * Run: node scripts/escrow.ts
 */
import { SomniaMarkets, isBinaryMarket } from "@somnia-chain/markets-sdk";
import { createPublicClient, defineChain, http, formatUnits } from "viem";

const RPC = "https://api.infra.testnet.somnia.network";
const WS = "wss://api.infra.testnet.somnia.network/ws";
const INDEXER = "https://dev.smk.somnia.host/v1/graphql";
const ME = "0x39D2bae5EAedA9283535dDC98F1991c81eD5Cd7E";
const MODULE = "0x3ecC694Cef705358864a646142ac17A90E29e388";
const COLLATERAL = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E";

const shannon = defineChain({
  id: 50312,
  name: "Somnia Shannon",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [RPC], webSocket: [WS] } },
});

const addresses = {
  binaryModule: MODULE,
  marketsCore: "0x2802504314685D89bF6C992CA5a8e7cC78bc0294",
  binarySettlement: "0xbF4a49e0Dfd092e5FBE8E5761064C49533e6Ed23",
  collateralRouter: "0xbC0C9834B15ACE38bB50dDaa7d7f7C7CC4DC183C",
  oracleHub: "0xe40db387cC98601Dd11bd634fF2f3AD5686dE32b",
  clobFactory: "0xb2BE8EE02F96379DB75f01802384593EBa9bfF04",
  binaryPoolImpl: "0x82A1FcdaA2daC2fC7D5f9909D43E68021eE966FD",
  marketCreator: "0x5Ce69567dB39C8fBAd7e048bEfdbcCdfE67B44e6",
  marketCreatorFactory: "0xE6bEE93cE87c9E6e62aCb621caa7832EE47b4F6B",
  collateral: COLLATERAL,
  testUsdc: COLLATERAL,
};

const MODULE_ABI = [
  {
    type: "function",
    name: "markets",
    stateMutability: "view",
    inputs: [{ name: "marketId", type: "bytes32" }],
    outputs: [
      { name: "oracleQuestionId", type: "uint256" },
      { name: "outcomeSlotCount", type: "uint8" },
      { name: "voidPolicy", type: "uint8" },
      { name: "collateral", type: "address" },
      { name: "originOperatorId", type: "uint32" },
      { name: "originVenueId", type: "bytes32" },
      { name: "oracleAdapter", type: "address" },
      { name: "creator", type: "address" },
      { name: "market", type: "address" },
      { name: "pool", type: "address" },
      { name: "yesId", type: "uint256" },
      { name: "noId", type: "uint256" },
      { name: "tradingStart", type: "uint64" },
      { name: "expiry", type: "uint64" },
    ],
  },
] as const;

const POOL_ABI = [
  {
    type: "function",
    name: "getAutoPullRequirement",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "isBid", type: "bool" },
      { name: "price", type: "uint256" },
      { name: "quantity", type: "uint256" },
      { name: "builderFeeBpsTimes1k", type: "uint96" },
    ],
    outputs: [
      { name: "inputToken", type: "address" },
      { name: "requiredAmount", type: "uint256" },
      { name: "delta", type: "uint256" },
    ],
  },
  { type: "function", name: "somiPaymentPerOrder", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

async function main() {
  const exchange = new SomniaMarkets({
    indexerUrl: INDEXER,
    chain: shannon,
    wsRpcUrl: WS,
    addresses: addresses as never,
  } as never);
  const pub = createPublicClient({ chain: shannon, transport: http(RPC) });

  const all = Object.values(await exchange.loadMarkets(true));
  const binaries = all.filter((m: any) => isBinaryMarket(m.info));

  // Pick a live, tradable market with plenty of life left.
  let chosen: any = null;
  const now = Date.now() / 1000;
  for (const m of binaries as any[]) {
    const oc: any = await exchange.client.getMarketOnchain(m.info.marketId);
    if (oc.status !== 1) continue;
    if (Number(m.info.expiry) - now < 600) continue;
    chosen = { m, oc };
    break;
  }
  if (!chosen) {
    console.log("no tradable market with >10min left; rerun shortly");
    return;
  }

  const { m } = chosen;
  const rec: any = await pub.readContract({
    address: MODULE as `0x${string}`,
    abi: MODULE_ABI,
    functionName: "markets",
    args: [m.info.marketId as `0x${string}`],
  });
  const pool = rec[9] as `0x${string}`;

  console.log("market :", m.symbol);
  console.log("pool   :", pool);
  console.log("yesId  :", String(rec[10]).slice(0, 24) + "...");
  console.log("noId   :", String(rec[11]).slice(0, 24) + "...");
  console.log("");

  try {
    const somi = await pub.readContract({ address: pool, abi: POOL_ABI, functionName: "somiPaymentPerOrder" });
    console.log("somiPaymentPerOrder:", String(somi), "(native cost per resting order)");
  } catch (e: any) {
    console.log("somiPaymentPerOrder: unavailable —", e?.shortMessage ?? e?.message);
  }
  console.log("");

  // 100 contracts. Collateral is 6-decimal tUSDC; a contract redeems for 1 unit.
  const QTY = 100_000_000n; // 100.00
  const prices: Array<[string, bigint]> = [
    ["0.30", 300_000_000_000_000_000n],
    ["0.50", 500_000_000_000_000_000n],
    ["0.70", 700_000_000_000_000_000n],
  ];

  console.log("getAutoPullRequirement for 100 contracts");
  console.log("side  price   token                                       required      per-contract");
  for (const [label, price] of prices) {
    for (const isBid of [true, false]) {
      try {
        const r: any = await pub.readContract({
          address: pool,
          abi: POOL_ABI,
          functionName: "getAutoPullRequirement",
          args: [ME as `0x${string}`, isBid, price, QTY, 0n],
        });
        const token = r[0] as string;
        const amount = r[1] as bigint;
        const isCollateral = token.toLowerCase() === COLLATERAL.toLowerCase();
        const per = Number(amount) / Number(QTY);
        console.log(
          `${isBid ? "BUY " : "SELL"}  ${label}    ${token}  ${formatUnits(amount, 6).padStart(11)}  ` +
            `${per.toFixed(4)} ${isCollateral ? "collateral" : "OUTCOME TOKEN"}`,
        );
      } catch (e: any) {
        console.log(`${isBid ? "BUY " : "SELL"}  ${label}    revert: ${(e?.shortMessage ?? e?.message ?? "").slice(0, 60)}`);
      }
    }
  }

  console.log("");
  console.log("--- verdict ---");
  console.log("If SELL pulls COLLATERAL at ~(1 - price) per contract, zero-inventory");
  console.log("two-sided quoting works and a bid/ask pair costs (1 - spread) per pair.");
  console.log("If SELL pulls the OUTCOME TOKEN, LiquidityVault must mintCompleteSet first");
  console.log("and the capital requirement is 1.0 per pair instead.");
}

main()
  .then(() => process.exit(0))
  .catch((e: any) => {
    console.error("FAILED:", e?.shortMessage ?? e?.message ?? e);
    process.exit(1);
  });
