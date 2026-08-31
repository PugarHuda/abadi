/**
 * Every vault this deployer has ever created, and what is still inside it.
 *
 * `scripts/lib/vaults.json` is a hand-maintained list, and a hand-maintained list is
 * how 5,000 tUSDC went missing: the vault at deployer nonce 8 was never written down,
 * so `ledger.ts`, `sweepOld` and the dashboard were all blind to it for five days. This
 * script does not read that list. It derives the addresses from the deployer's nonce
 * sequence — CREATE is `keccak(rlp(sender, nonce))[12:]`, so nonce 0..N is every contract
 * this key has ever made, whether anyone wrote it down or not — and asks each one what it
 * holds.
 *
 * Read-only by default. `--send` redeems, and only where the operator's own shares
 * simulate clean:
 *
 *   node scripts/recover.ts              list what is out there
 *   node scripts/recover.ts --send       redeem it
 *   node scripts/recover.ts --send --to 0x...   redeem to somewhere other than the operator
 */
import { createPublicClient, createWalletClient, http, parseAbi, getContractAddress, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { shannon, RPC, env, addresses } from "./lib/somnia.ts";

const VAULT_ABI = parseAbi([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function maxRedeem(address) view returns (uint256)",
  "function previewRedeem(uint256) view returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
  "function symbol() view returns (string)",
]);
const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const usd = (v: bigint) => Number(formatUnits(v, 6)).toFixed(2).padStart(11);

async function main() {
  const send = process.argv.includes("--send");
  const toArg = process.argv[process.argv.indexOf("--to") + 1];
  const account = privateKeyToAccount(env().PRIVATE_KEY as `0x${string}`);
  const to = (process.argv.includes("--to") ? toArg : account.address) as `0x${string}`;

  const pub = createPublicClient({ chain: shannon, transport: http(RPC) });
  const wallet = createWalletClient({ account, chain: shannon, transport: http(RPC) });

  // The live vault is in this sweep like every other CREATE, and draining it is not a
  // recovery — it is a shutdown, with an open slot's legs left behind. It comes out
  // unless someone says otherwise in as many words.
  const live = readFileSync(".vault-addr", "utf8").trim().toLowerCase();
  const includeLive = process.argv.includes("--include-live");

  // The current nonce is the next one CREATE will use, so 0..nonce-1 is everything made
  // so far. Deploys still in flight are not our problem; they hold nothing yet.
  const nonce = await pub.getTransactionCount({ address: account.address });
  console.log("deployer", account.address);
  console.log("nonce   ", nonce, `— checking every CREATE address 0..${nonce - 1}`);
  console.log("");
  console.log("nonce  address                                     symbol    assets      supply   our shares   redeemable");

  const found: { address: `0x${string}`; shares: bigint; out: bigint }[] = [];
  let dust = 0n;

  for (let n = 0; n < nonce; n++) {
    const address = getContractAddress({ from: account.address, nonce: BigInt(n) });
    const code = await pub.getCode({ address });
    if (!code || code === "0x") continue;

    // Not every CREATE here is a vault — three of them are the reactivity probes, which
    // have no ERC-4626 surface at all. A failing `asset()` is the cheapest way to tell.
    let symbol: string;
    try {
      symbol = (await pub.readContract({ address, abi: VAULT_ABI, functionName: "symbol" })) as string;
      await pub.readContract({ address, abi: VAULT_ABI, functionName: "asset" });
    } catch {
      const stt = await pub.getBalance({ address });
      if (stt > 0n) {
        dust += stt;
        console.log(`${String(n).padStart(5)}  ${address}  not a vault${" ".repeat(12)}holds ${Number(formatUnits(stt, 18)).toFixed(4)} STT`);
      }
      continue;
    }

    const [assets, supply, shares] = (await Promise.all([
      pub.readContract({ address, abi: VAULT_ABI, functionName: "totalAssets" }),
      pub.readContract({ address, abi: VAULT_ABI, functionName: "totalSupply" }),
      pub.readContract({ address, abi: VAULT_ABI, functionName: "balanceOf", args: [account.address] }),
    ])) as bigint[];

    let redeemable = 0n;
    let max = 0n;
    if (shares > 0n) {
      // maxRedeem is what the vault will actually let go of today — the audited build caps
      // it by idle cash and the open-slot floor, so it can be well under the balance.
      max = (await pub.readContract({ address, abi: VAULT_ABI, functionName: "maxRedeem", args: [account.address] })) as bigint;
      redeemable = max > 0n
        ? ((await pub.readContract({ address, abi: VAULT_ABI, functionName: "previewRedeem", args: [max] })) as bigint)
        : 0n;
    }

    const isLive = address.toLowerCase() === live;
    console.log(
      `${String(n).padStart(5)}  ${address}  ${symbol.padEnd(8)} ${usd(assets)} ${usd(supply)} ${usd(shares)} ${usd(redeemable)}${isLive ? "   <- LIVE" : ""}`,
    );
    if (isLive && !includeLive) console.log(`       ^ the live vault; left alone (--include-live to drain it)`);
    else if (max > 0n && redeemable > 0n) found.push({ address, shares: max, out: redeemable });
    else if (shares > 0n) console.log(`       ^ holds shares but maxRedeem is 0 — nothing to take today`);
  }

  const total = found.reduce((a, f) => a + f.out, 0n);
  console.log("");
  console.log(`recoverable: ${usd(total).trim()} tUSDC across ${found.length} vault(s)`);
  if (dust > 0n) console.log(`stranded   : ${Number(formatUnits(dust, 18)).toFixed(4)} STT in non-vault contracts with no exit`);
  if (!send) {
    console.log("");
    console.log("read-only. re-run with --send to redeem.");
    return;
  }

  const before = (await pub.readContract({ address: addresses.testUsdc, abi: ERC20_ABI, functionName: "balanceOf", args: [to] })) as bigint;
  console.log("");
  console.log(`receiver ${to} holds ${usd(before).trim()} tUSDC before`);

  for (const f of found) {
    // Simulate first. A redeem that reverts on chain still costs gas and, worse, leaves
    // the operator believing the money moved. And these older builds do not cap
    // `maxRedeem` by idle cash — the vault will happily quote a `previewRedeem` backed by
    // a position rather than by tUSDC — so a refusal here is expected on some of them and
    // is not a reason to abandon the vaults further down the list.
    let request;
    try {
      ({ request } = await pub.simulateContract({
        account,
        address: f.address,
        abi: VAULT_ABI,
        functionName: "redeem",
        args: [f.shares, to, account.address],
      }));
    } catch (e: any) {
      console.log(`skip     ${f.address}  ${usd(f.out).trim()} tUSDC promised but the redeem does not simulate: ${String(e?.shortMessage ?? e?.message ?? e).split("\n")[0]}`);
      continue;
    }
    const hash = await wallet.writeContract(request);
    const rcpt = await pub.waitForTransactionReceipt({ hash });
    console.log(`redeem   ${f.address}  ${usd(f.out).trim()} tUSDC  ${rcpt.status}  ${hash}  gas ${rcpt.gasUsed}`);
  }

  const after = (await pub.readContract({ address: addresses.testUsdc, abi: ERC20_ABI, functionName: "balanceOf", args: [to] })) as bigint;
  console.log("");
  console.log(`receiver holds ${usd(after).trim()} tUSDC after — moved ${usd(after - before).trim()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
