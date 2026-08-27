/**
 * One source for the Shannon deployment. Ten scripts had their own copy of this
 * eleven-address literal; a redeploy would have needed ten correct edits, and the
 * ninth would have been the one that got missed.
 *
 * Addresses verified against docs.dreamdex.io and the bot-kit deployment map.
 * The protocol core is CREATE3-deployed, so it is identical on testnet and mainnet —
 * only the collateral and the market creator differ.
 */
import { SomniaMarkets } from "@somnia-chain/markets-sdk";
import { defineChain } from "viem";
import { readFileSync } from "node:fs";

export const RPC = process.env.RPC_URL ?? "https://api.infra.testnet.somnia.network";
export const WS = process.env.WS_RPC_URL ?? "wss://api.infra.testnet.somnia.network/ws";
export const INDEXER = process.env.INDEXER_URL ?? "https://dev.smk.somnia.host/v1/graphql";
export const VENUE = process.env.VENUE_ID ?? "0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c";

export const shannon = defineChain({
  id: 50312,
  name: "Somnia Shannon",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [RPC], webSocket: [WS] } },
});

export const addresses = {
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
} as const;

export const OUTCOME_TOKEN = "0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9";

/** 1.0 in price units = 10 ** collateral.decimals(). tUSDC is 6, NOT 1e18. */
export const PRICE_ONE = 1_000_000n;
/** precision.price = 3 on this venue, so the grid step is 0.001. */
export const TICK = 1_000n;
export const LOT = 1_000n;

export function exchange(withSigner = false) {
  return new SomniaMarkets({
    indexerUrl: INDEXER,
    chain: shannon,
    wsRpcUrl: WS,
    addresses: addresses as never,
    ...(withSigner ? { privateKey: env().PRIVATE_KEY } : {}),
  } as never);
}

export function env(): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(".env", "utf8")
        .split(/\r?\n/)
        .filter((l) => l && !l.startsWith("#") && l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
  } catch {
    return {};
  }
}

/**
 * The indexer returns `RegistryMarkets failed: fetch failed` roughly one call in five.
 * A bot that treats that as fatal dies at random, so every read goes through here.
 */
export async function retry<T>(label: string, fn: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      last = e;
      const msg = String(e?.shortMessage ?? e?.message ?? e);
      if (!/fetch failed|ECONNRESET|ETIMEDOUT|502|503|504/i.test(msg)) throw e;
      const wait = 400 * 2 ** i;
      console.error(`  ${label}: ${msg.slice(0, 70)} — retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}
