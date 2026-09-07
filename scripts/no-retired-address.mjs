/**
 * No page, script or document may name a vault that has been retired.
 *
 * The address gate already checks that the CURRENT address appears where it should. This is
 * the other half, and it is the half that was missing: on 2026-09-07 the landing page's
 * "Vault on the explorer" link was a literal pointing at the vault retired an hour earlier,
 * and the film's shot list had the same literal. Both passed every check, because a gate that
 * asks "is the right address present" cannot see a wrong one sitting beside it.
 *
 * `scripts/lib/vaults.json` is the list of everything retired, so it is also the list of what
 * must not be named. The registry itself, the generated deployments file and `docs/evidence/`
 * are exempt: naming a retired vault is exactly their job.
 *
 *   node scripts/no-retired-address.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const RETIRED = JSON.parse(readFileSync("scripts/lib/vaults.json", "utf8")).map((v) =>
  v.address.toLowerCase(),
);
const LIVE = readFileSync(".vault-addr", "utf8").trim().toLowerCase();

const ROOTS = ["app", "public", "video", "qa", "scripts", ".github", "src", "test"];
/* Code and shipped surfaces only. The top-level prose tells the history of every vault this
 * project has deployed — naming a retired one there is the point — and the separate address
 * gate already requires README to carry the live one. */
const FILES = [];
const SKIP = /node_modules|[\\/]out[\\/]|[\\/]dist[\\/]|\.next|vaults\.json|deployments\.json|evidence[\\/]|\.png$|\.mp4$|\.mp3$|\.woff2?$/i;
const TEXT = new Set([".ts", ".tsx", ".js", ".mjs", ".json", ".md", ".css", ".html", ".txt", ".yml", ".sol", ".srt"]);

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e);
    if (SKIP.test(p)) continue;
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (TEXT.has(extname(p))) yield p;
  }
}

const found = [];
for (const file of [...ROOTS.flatMap((r) => [...walk(r)]), ...FILES]) {
  if (SKIP.test(file)) continue;
  let text;
  try { text = readFileSync(file, "utf8").toLowerCase(); } catch { continue; }
  for (const addr of RETIRED) {
    if (addr === LIVE) continue;
    if (text.includes(addr)) found.push(`${file} names retired ${addr}`);
  }
}

if (found.length) {
  console.error("A retired vault is named outside the registry and the evidence:");
  for (const f of found) console.error(`  ${f}`);
  console.error("\nRead the address from `.vault-addr` instead of writing it down.");
  process.exit(1);
}
console.log(`ok  no retired vault named outside the registry (${RETIRED.length} retired, live ${LIVE})`);
