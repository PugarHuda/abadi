/**
 * Is the live address running this source?
 *
 * Nobody asked that for a day, and the answer was no: the deployed vault predated
 * `settle` entirely, so the one path never exercised on chain was also the one path
 * never deployed. A complete set worth 100 tUSDC is still stranded in it.
 *
 * Compares the deployed runtime bytecode against the build artifact, ignoring the
 * immutable slots — those are constructor arguments burned into the code and differ by
 * design. Anything differing outside them means the address is not this source.
 *
 * Read-only. Run: forge build && node scripts/attest.ts [address]
 */
import { createPublicClient, http } from "viem";
import { readFileSync } from "node:fs";
import { shannon, RPC } from "./lib/somnia.ts";

const ARTIFACT = "out/LiquidityVault.sol/LiquidityVault.json";

async function main() {
  const address = (process.argv[2] ?? readFileSync(".vault-addr", "utf8").trim()) as `0x${string}`;
  const art = JSON.parse(readFileSync(ARTIFACT, "utf8"));
  const local: string = art.deployedBytecode.object;

  const pub = createPublicClient({ chain: shannon, transport: http(RPC) });
  const onchain = await pub.getCode({ address });
  if (!onchain) throw new Error(`no code at ${address}`);

  // Immutables are written at construction, so the artifact carries zeroes where the
  // deployed copy carries the arguments. Everything else must match byte for byte.
  const masked = new Set<number>();
  for (const ranges of Object.values(art.deployedBytecode.immutableReferences ?? {}) as any[]) {
    for (const r of ranges) for (let i = 0; i < r.length; i++) masked.add(r.start + i);
  }

  console.log("address ", address);
  console.log("artifact", ARTIFACT);

  if (onchain.length !== local.length) {
    console.log(`MISMATCH  length ${onchain.length} on chain vs ${local.length} built`);
    process.exit(1);
  }

  let differing = 0;
  const offenders: number[] = [];
  for (let b = 0; b * 2 + 4 <= local.length; b++) {
    if (local.slice(2 + b * 2, 4 + b * 2) === onchain.slice(2 + b * 2, 4 + b * 2)) continue;
    differing++;
    if (!masked.has(b)) offenders.push(b);
  }

  console.log(`${differing} bytes differ, against ${masked.size} bytes of immutables they are allowed to differ in`);
  if (offenders.length > 0) {
    console.log(`MISMATCH  ${offenders.length} bytes differ outside the immutables`);
    console.log(`first at offset ${offenders[0]} — the live address is not this source`);
    process.exit(1);
  }
  console.log("MATCH  the live address is running this source");
}

main().catch((e: any) => {
  console.error("FAILED:", e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
