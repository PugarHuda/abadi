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

/** Read-only, always. Every write in this repo goes through viem with an explicit account.
 *
 *  This used to take `withSigner`, which no caller ever passed, whose only effect was to
 *  hand the operator's private key to the SDK. A dead branch is worth deleting on its own;
 *  a dead branch that loads a key is worth deleting first. */
export function exchange() {
  return new SomniaMarkets({
    indexerUrl: INDEXER,
    chain: shannon,
    wsRpcUrl: WS,
    addresses: addresses as never,
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
 *
 * `timeoutMs` is the other half of that, and it was missing for the whole life of this
 * file. Retrying only helps when the call FAILS; a host that accepts the socket and then
 * says nothing never rejects, so the loop below waits on it forever. This repository has
 * written that sentence twice already — for `web/ledger.js` and for `scripts/impact.ts` —
 * and `retry` is the wrapper around every indexer read the live bot makes.
 *
 * It is measured, not theoretical: **26 of 1,141 scheduled keeper runs logged their
 * header and never reached a single cycle**, six of them in the three days to 2026-09-10,
 * every one dying between the `fv` line and the first book sample — which is where
 * `loadMarkets` is called. The Windows task limit (PT14M) killed them, so the failure
 * left no error line, only a missing cycle.
 *
 * Left off by default: a timeout on a call that legitimately takes minutes is a new way
 * to fail. Pass it where the wait has a measured shape. For `loadMarkets` that shape is
 * p50 58s, p99 93s over 859 runs, so 180s is twice the tail and still four times a
 * typical call.
 */
export async function retry<T>(
  label: string,
  fn: () => Promise<T>,
  tries = 4,
  timeoutMs?: number,
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      /* The timer is cleared on both paths. Left dangling it keeps the event loop alive,
         and a script that has finished its work but will not exit reads exactly like a
         script that has hung — which is the thing this argument exists to stop. */
      if (timeoutMs === undefined) return await fn();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          fn(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`no answer in ${timeoutMs >= 1000 ? Math.round(timeoutMs / 1000) + "s" : timeoutMs + "ms"}`)), timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch (e: any) {
      last = e;
      const msg = String(e?.shortMessage ?? e?.message ?? e);
      if (!/fetch failed|ECONNRESET|ETIMEDOUT|no answer in|502|503|504/i.test(msg)) throw e;
      const wait = 400 * 2 ** i;
      console.error(`  ${label}: ${msg.slice(0, 70)} — retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}

// ---- self-check, offline. `node scripts/lib/somnia.ts --self-check`
//
// `retry` is the wrapper around every indexer read the live bot makes and had no test.
// The race added to it is the kind of thing that looks right and leaks: a timer nobody
// clears holds the event loop open, and a bot that finishes its work and will not exit
// is indistinguishable from the hang this was written to end.
if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/lib/somnia.ts") && process.argv.includes("--self-check")) {
  const ok = (cond: unknown, what: string) => { if (!cond) throw new Error(what); };
  const started = Date.now();

  // A call that never settles is the whole point: no rejection, so the retry loop alone
  // waits forever. With a timeout it becomes an error the loop can act on.
  const hang = () => new Promise<string>(() => {});
  let threw = "";
  try { await retry("hang", hang, 2, 60); } catch (e: any) { threw = String(e?.message ?? e); }
  ok(/no answer in/.test(threw), `a hanging call must time out, got: ${threw}`);

  // ...and the attempt after a timeout still runs, so a slow moment is not a dead cycle.
  let n = 0;
  const flaky = () => (++n === 1 ? new Promise<string>(() => {}) : Promise.resolve("second"));
  ok((await retry("flaky", flaky, 2, 60)) === "second", "the retry after a timeout must run");

  // A real error is not a timeout and must not be swallowed or retried into one.
  let calls = 0;
  const bad = () => { calls++; return Promise.reject(new Error("nonsense")); };
  let msg = "";
  try { await retry("bad", bad, 3, 60); } catch (e: any) { msg = String(e?.message ?? e); }
  ok(msg === "nonsense", `a non-retryable error is rethrown, got: ${msg}`);
  ok(calls === 1, `a non-retryable error is not retried, called ${calls} times`);

  // Without the argument, nothing changed: this is the path every other caller is on.
  ok((await retry("plain", () => Promise.resolve(7))) === 7, "no timeout argument still resolves");

  ok(Date.now() - started < 5000, "the self-check must not itself hang");
  console.log("ok  somnia self-check  (if this process does not exit, a timer leaked)");
}
