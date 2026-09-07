/**
 * Publish every signature this project can see to 4byte.directory.
 *
 * Two databases matter and they are not the same one. `forge selectors upload --all` posts
 * to OpenChain, which is what `cast 4byte`, Foundry traces and Blockscout resolve against —
 * that half is one command and needs no script. 4byte.directory is the other one, read by
 * Etherscan-family explorers and most block viewers, and it takes one signature per POST.
 *
 * The 2026-09-06 upload to it was done by hand and is not reproducible: two spot checks came
 * back empty afterwards and there was no way to tell which of the 90 went in. This is that
 * step written down, so the answer is a number instead of a memory.
 *
 * What goes up: this vault's own ABI, plus every ABI array the venue's SDK exports. The
 * venue's contracts are unverified beacon proxies, so their reverts decode to a bare four
 * bytes for every integrator on Somnia. That is fixable for free, once, for everybody.
 *
 *   node scripts/selectors.mjs            # count what is missing, send nothing
 *   node scripts/selectors.mjs --send     # publish
 */
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const SEND = process.argv.includes("--send");
const FN = "https://www.4byte.directory/api/v1/signatures/";
const EV = "https://www.4byte.directory/api/v1/event-signatures/";

/** A host that accepts the socket and then says nothing leaves `fetch` pending forever —
 *  this project has been bitten by that on chain data and will not be bitten by it here. */
const post = (url, text_signature) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text_signature }),
    signal: AbortSignal.timeout(20_000),
  });

/** Canonical form: `name(type,type)`, tuples expanded, which is what both databases hash. */
const typeOf = (i) =>
  i.type.startsWith("tuple") ? `(${i.components.map(typeOf).join(",")})${i.type.slice(5)}` : i.type;
const sigOf = (e) => `${e.name}(${(e.inputs ?? []).map(typeOf).join(",")})`;

const fns = new Set();
const evs = new Set();
function collect(abi, from) {
  let n = 0;
  for (const e of abi) {
    if (!e?.name || !Array.isArray(e.inputs)) continue;
    if (e.type === "function" || e.type === "error") fns.add(sigOf(e)), n++;
    else if (e.type === "event") evs.add(sigOf(e)), n++;
  }
  if (n) console.log(`  ${from.padEnd(28)} ${n}`);
}

console.log("sources");
collect(JSON.parse(readFileSync("public/abi.json", "utf8")), "public/abi.json");

/* Every array the SDK ships that looks like an ABI. Naming the four we happen to know would
 * miss the next one the venue adds; the shape is the reliable filter.
 *
 * Both the package root AND its `dist/` files, because the two do not agree: the root export
 * map does not expose `contractErrorsAbi`, and that is the 418-entry error table — the single
 * most useful thing on this list and the reason any of this matters. Importing it by file URL
 * goes around the export map, which is the point. */
const seen = new Set();
async function scan(href, label) {
  let mod;
  try { mod = await import(href); } catch { return; }
  for (const [k, v] of Object.entries(mod)) {
    if (seen.has(k)) continue;
    if (Array.isArray(v) && v.some((e) => e?.type === "function" || e?.type === "error" || e?.type === "event")) {
      seen.add(k);
      collect(v, label ? `${label}:${k}` : k);
    }
  }
}
await scan("@somnia-chain/markets-sdk");
const DIST = "node_modules/@somnia-chain/markets-sdk/dist";
for (const f of readdirSync(DIST)) {
  if (f.endsWith(".js")) await scan(pathToFileURL(join(DIST, f)).href, "dist");
}

console.log(`\n${fns.size} functions and errors, ${evs.size} events, deduplicated`);
if (!SEND) {
  console.log("\nRead-only. Re-run with --send to publish them.");
  process.exit(0);
}

let created = 0, duplicate = 0, failed = 0;
for (const [url, set] of [[FN, fns], [EV, evs]]) {
  for (const sig of set) {
    try {
      const r = await post(url, sig);
      if (r.ok) { created++; continue; }
      const body = await r.text();
      if (r.status === 400 && body.includes("already exists")) duplicate++;
      else { failed++; console.log(`  refused ${sig}: ${r.status} ${body.slice(0, 120)}`); }
    } catch (e) {
      failed++;
      console.log(`  failed  ${sig}: ${String(e?.message ?? e).split("\n")[0]}`);
    }
  }
}
console.log(`\nnewly registered ${created}   already known ${duplicate}   refused ${failed}`);

// The claim this script exists to make true is "it is in the database", so read it back.
const sample = [...fns].slice(0, 3);
for (const sig of sample) {
  const r = await fetch(`https://www.4byte.directory/api/v1/signatures/?text_signature=${encodeURIComponent(sig)}`, {
    signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json();
  console.log(`verify  ${j.count ? "OK  " : "MISSING "} ${sig}`);
}
