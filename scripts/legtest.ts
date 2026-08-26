/**
 * Isolates which leg of the two-sided quote trips PostOnlyWouldCross.
 *
 * Places ONE post-only leg at a time, direct from the EOA to the pool, at prices that
 * cannot possibly cross. Whatever survives tells us the real semantics of `kind` and
 * `price`, rather than what the ABI comment implies.
 *
 * Tiny sizes. Cancels everything it places.
 * Run: node scripts/legtest.ts
 */
import { SomniaMarkets, isBinaryMarket } from "@somnia-chain/markets-sdk";
import { createPublicClient, createWalletClient, defineChain, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";

const RPC = "https://api.infra.testnet.somnia.network";
const WS = "wss://api.infra.testnet.somnia.network/ws";
const INDEXER = "https://dev.smk.somnia.host/v1/graphql";
const MODULE = "0x3ecC694Cef705358864a646142ac17A90E29e388";
const COLL = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E";

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
  collateral: COLL,
  testUsdc: COLL,
};

const POOL_ABI = parseAbi([
  "function placeBinaryOrder(uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k, uint64 userData) payable returns (bool success, uint128 id)",
  "function cancelOrder(uint128 orderId)",
]);
const ERC20_ABI = parseAbi(["function approve(address,uint256) returns (bool)"]);
const MODULE_ABI = parseAbi([
  "function markets(bytes32) view returns (uint256,uint8,uint8,address,uint32,bytes32,address,address,address,address,uint256,uint256,uint64,uint64)",
]);

const TICK = 10n ** 15n;
const QTY = 1_000_000n; // 1 contract
const KINDS: Array<[number, string]> = [
  [0, "BUY_YES"],
  [1, "SELL_YES"],
  [2, "BUY_NO"],
  [3, "SELL_NO"],
];

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

const toWei = (x: number) => BigInt(Math.round(x * 1000)) * TICK;
const f = (w: bigint) => (Number(w) / 1e18).toFixed(3);

async function main() {
  const account = privateKeyToAccount(env.PRIVATE_KEY as `0x${string}`);
  const pub = createPublicClient({ chain: shannon, transport: http(RPC) });
  const wallet = createWalletClient({ account, chain: shannon, transport: http(RPC) });
  const ex = new SomniaMarkets({
    indexerUrl: INDEXER, chain: shannon, wsRpcUrl: WS, addresses: addresses as never,
  } as never);

  const all = Object.values(await ex.loadMarkets(true));
  const now = Date.now() / 1000;
  const cands = (all.filter((x: any) => isBinaryMarket(x.info)) as any[])
    .filter((m) => Number(m.info.intervalSec || 0) >= 14400)
    .sort((a, b) => Number(b.info.intervalSec) - Number(a.info.intervalSec));

  let chosen: any = null;
  for (const m of cands) {
    const oc: any = await ex.client.getMarketOnchain(m.info.marketId);
    if (oc.status !== 1) continue;
    if (Number(m.info.expiry) - now < 3600) continue;
    const up = m.outcomes?.[0]?.symbol;
    const book: any = up ? await ex.fetchOrderBook(up, 5).catch(() => null) : null;
    if (!book?.bids?.[0] || !book?.asks?.[0]) continue;
    chosen = { m, book, expiry: Number(m.info.expiry) };
    break;
  }
  if (!chosen) return console.log("no suitable market");

  const { m, book, expiry } = chosen;
  const bid = toWei(book.bids[0][0]);
  const ask = toWei(book.asks[0][0]);
  const rec: any = await pub.readContract({
    address: MODULE as `0x${string}`, abi: MODULE_ABI, functionName: "markets",
    args: [m.info.marketId as `0x${string}`],
  });
  const pool = rec[9] as `0x${string}`;

  console.log("market:", m.symbol, "  pool:", pool);
  console.log(`book  : bid ${f(bid)} / ask ${f(ask)}`);
  console.log("");

  const hash = await wallet.writeContract({
    address: COLL as `0x${string}`, abi: ERC20_ABI, functionName: "approve",
    args: [pool, 10n ** 12n],
  });
  await pub.waitForTransactionReceipt({ hash });
  console.log("approved pool for collateral");
  console.log("");

  const deadlineNs = BigInt(expiry) * 1_000_000_000n;
  // Prices far from the touch on both sides, so nothing can legitimately cross.
  const probes: Array<[bigint, string]> = [
    [bid - 50n * TICK, "far below bid"],
    [ask + 50n * TICK, "far above ask"],
  ];

  console.log("kind      price   where            result");
  for (const [kind, kname] of KINDS) {
    for (const [price, where] of probes) {
      if (price <= 0n || price >= 10n ** 18n) continue;
      let out = "";
      try {
        const { result } = await pub.simulateContract({
          address: pool, abi: POOL_ABI, functionName: "placeBinaryOrder",
          args: [kind, price, QTY, deadlineNs, 3, 0, "0x0000000000000000000000000000000000000000", 0n, 0n],
          account,
        });
        out = `OK success=${(result as any)[0]}`;
      } catch (e: any) {
        const msg = e?.shortMessage ?? e?.message ?? String(e);
        const m2 = msg.match(/reverted with the following signature:\s*(0x[0-9a-f]{8})/i);
        out = m2 ? decode(m2[1]) : msg.split("\n")[0].slice(0, 46);
      }
      console.log(`${kname.padEnd(9)} ${f(price)}   ${where.padEnd(16)} ${out}`);
    }
  }
}

function decode(sel: string): string {
  const known: Record<string, string> = {
    "0x7cf05fcb": "PostOnlyWouldCross",
    "0x2c5211c6": "InvalidAmount",
    "0x7939f424": "InvalidPrice",
  };
  return known[sel] ?? sel;
}

main().then(() => process.exit(0)).catch((e: any) => {
  console.error("FAILED:", e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
