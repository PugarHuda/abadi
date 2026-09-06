/**
 * Read, and set, the two on-chain bounds on what the operator key can commit.
 *
 * `LiquidityVault` carries a twenty-line comment saying why these exist: the custody claim —
 * "the operator can steer quotes and cannot move a token" — is true and was the wrong thing
 * to be reassured by. The operator cannot TRANSFER the money; it could trade it away. It
 * picks the market, the mid, the half-spread and the size, and without these two limits the
 * only bound is `escrow <= idle`. One quote could commit the entire vault.
 *
 * Both default to 0, which DISABLES them, and on 2026-09-06 the live vault was read and
 * both were still 0 — the argument was written, the setter was written and tested, and
 * nothing had ever called it. `setExposureLimits` appeared in no script, no keeper, no CI
 * and no evidence file. That is why this script exists rather than a one-off `cast send`:
 * the limits reset to 0 on every redeploy, and a step nobody can run is a step that will be
 * skipped again.
 *
 *   node scripts/risk.ts            # read what is set
 *   node scripts/risk.ts --send     # set the defaults below
 *
 * Governor-only, because it is a risk decision and not a trading one.
 */
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { shannon, RPC, env } from "./lib/somnia.ts";

const ABI = parseAbi([
  "function maxQuoteNotional() view returns (uint256)",
  "function maxDeployedBps() view returns (uint16)",
  "function totalAssets() view returns (uint256)",
  "function totalEscrowed() view returns (uint256)",
  "function MAX_SLOTS() view returns (uint256)",
  "function governor() view returns (address)",
  "function setExposureLimits(uint256 maxQuoteNotional_, uint16 maxDeployedBps_)",
]);

/* The numbers, and why these and not others.
 *
 * A quote of 100 contracts escrows about 98 — bid plus (1 - ask), per contract. 500 gives
 * five times that, so the size can grow without a governor call, and a fat-fingered or
 * mispriced quote still cannot reach past a twentieth of the vault.
 *
 * The vault's own comment records measured utilisation at 0-6% of NAV. 25% is four times the
 * observed peak, so this does not constrain how the vault trades; it constrains how far it
 * could be pushed in one direction. It is also the binding one: eight slots at 500 each is
 * 4,000, well past 25% of a 9,300 NAV, so the book-wide cap is what stops first — which is
 * the point of having both. */
const MAX_QUOTE = 500_000_000n; // 500 tUSDC, at the collateral's six decimals
const MAX_DEPLOYED_BPS = 2500; // 25% of NAV across every open quote at once

const usd = (v: bigint) => (Number(v) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  const vault = readFileSync(".vault-addr", "utf8").trim() as `0x${string}`;
  const pub = createPublicClient({ chain: shannon, transport: http(RPC) });
  const read = <T>(fn: string) =>
    pub.readContract({ address: vault, abi: ABI, functionName: fn as never }) as Promise<T>;

  const [quoteCap, bps, nav, escrow, slots, governor] = await Promise.all([
    read<bigint>("maxQuoteNotional"),
    read<number>("maxDeployedBps"),
    read<bigint>("totalAssets"),
    read<bigint>("totalEscrowed"),
    read<bigint>("MAX_SLOTS"),
    read<`0x${string}`>("governor"),
  ]);

  console.log("vault              ", vault);
  console.log("NAV                ", usd(nav), "tUSDC");
  console.log("open escrow        ", usd(escrow), `tUSDC  (${((Number(escrow) / Number(nav)) * 100).toFixed(2)}% of NAV, ${slots} slots)`);
  console.log("");
  console.log("maxQuoteNotional   ", quoteCap === 0n ? "0  — DISABLED, one quote may commit the whole vault" : usd(quoteCap) + " tUSDC");
  console.log(
    "maxDeployedBps     ",
    bps === 0 ? "0  — DISABLED, the whole book is unbounded" : `${bps} (${(bps / 100).toFixed(2)}% of NAV = ${usd((nav * BigInt(bps)) / 10_000n)} tUSDC)`,
  );

  if (!process.argv.includes("--send")) {
    if (quoteCap === 0n || bps === 0) {
      console.log("");
      console.log(`Both are governor-set and cost one transaction. \`node scripts/risk.ts --send\``);
      console.log(`would set ${usd(MAX_QUOTE)} per quote and ${MAX_DEPLOYED_BPS} bps across the book.`);
      process.exitCode = 1;
    }
    return;
  }

  const account = privateKeyToAccount(env().PRIVATE_KEY as `0x${string}`);
  if (account.address.toLowerCase() !== governor.toLowerCase()) {
    throw new Error(`this key is ${account.address}, the governor is ${governor}`);
  }

  // Simulate first. A revert here costs nothing; a revert on chain costs gas and leaves the
  // limits wherever they were, which is the state this script exists to end.
  const { request } = await pub.simulateContract({
    address: vault,
    abi: ABI,
    functionName: "setExposureLimits",
    args: [MAX_QUOTE, MAX_DEPLOYED_BPS],
    account,
  });

  const wallet = createWalletClient({ account, chain: shannon, transport: http(RPC) });
  const hash = await wallet.writeContract(request);
  console.log("");
  console.log("sent               ", hash);
  const rec = await pub.waitForTransactionReceipt({ hash });
  console.log("status             ", rec.status, "in block", rec.blockNumber.toString());

  const [nowQuote, nowBps] = await Promise.all([read<bigint>("maxQuoteNotional"), read<number>("maxDeployedBps")]);
  console.log("maxQuoteNotional   ", usd(nowQuote), "tUSDC");
  console.log("maxDeployedBps     ", nowBps, `(${usd((nav * BigInt(nowBps)) / 10_000n)} tUSDC of this NAV)`);
  if (nowQuote !== MAX_QUOTE || nowBps !== MAX_DEPLOYED_BPS) throw new Error("the chain did not take the values");
}

main().catch((e: any) => {
  console.error("FAILED:", e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
