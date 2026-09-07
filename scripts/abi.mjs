/* Publish the vault's ABI to the site, and keep it from drifting.
 *
 * `public/abi.json` is served at https://abadi-wheat.vercel.app/abi.json so another project can
 * call this vault without cloning the repo and running `forge build`. Five other entries in
 * this hackathon put capital into the same order book; asking them to compile our contracts
 * to read `totalAssets` is a strange thing to ask.
 *
 * It is COMMITTED rather than generated at deploy time, and that is not laziness — it is the
 * only shape that works. The site build runs `next build` on Vercel, where there is no
 * Foundry. Generating the ABI during it took production down the moment it was tried:
 * `ENOENT: forge-out/LiquidityVault.sol/LiquidityVault.json`, on Vercel and in the `web` CI
 * job alike, because neither of them compiles Solidity.
 *
 * A committed artifact can go stale, so it is gated instead of trusted. `--check` runs in the
 * `contracts` CI job, where Foundry does exist, and fails the build if the published file is
 * not exactly what the current source compiles to. Same idea as the test-count gate: if a
 * fact is going to be asserted outside the code, something has to check it.
 *
 *   node scripts/abi.mjs           # regenerate public/abi.json after changing the contract
 *   node scripts/abi.mjs --check   # fail if it is out of date (CI)
 */
import { readFileSync, writeFileSync } from "node:fs";

const ARTIFACT = "forge-out/LiquidityVault.sol/LiquidityVault.json";
const PUBLISHED = "public/abi.json";

let artifact;
try {
  artifact = JSON.parse(readFileSync(ARTIFACT, "utf8"));
} catch {
  console.error(`${ARTIFACT} is not there. Run \`forge build\` first — this script needs the`);
  console.error("compiler's own output, not a hand-written list.");
  process.exit(1);
}

const wanted = JSON.stringify(artifact.abi, null, 2) + "\n";

if (process.argv.includes("--check")) {
  let have = null;
  try {
    have = readFileSync(PUBLISHED, "utf8");
  } catch {}
  if (have !== wanted) {
    console.error(`${PUBLISHED} does not match what ${ARTIFACT} compiles to.`);
    console.error("The site publishes that file as this vault's ABI, so a stale copy tells");
    console.error("an integrator to call functions that may not exist.");
    console.error("");
    console.error("  node scripts/abi.mjs      # regenerate, then commit it");
    process.exit(1);
  }
  const n = artifact.abi.length;
  console.log(`ok  ${PUBLISHED} is the compiled ABI (${n} entries)`);
} else {
  writeFileSync(PUBLISHED, wanted);
  console.log(`wrote ${PUBLISHED}  (${artifact.abi.length} entries)`);
}
