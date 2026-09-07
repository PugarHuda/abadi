/**
 * Did the framework change the page?
 *
 * The migration from hand-written HTML to App Router routes was mechanical
 * (`scripts/to-jsx.mjs`), and a mechanical transform is only trustworthy if somebody checks
 * the output. This renders the OLD build from `web/*.html` and compares each page's body
 * against the NEW export in `out/`, ignoring the things a framework is entitled to change:
 * its own script and stylesheet tags, hydration markers, attribute order and whitespace.
 *
 * Anything left is a real difference in what a reader sees, and it is printed.
 *
 *   node scripts/compare-render.mjs
 *
 * Exit 1 on any difference, so it can gate a build.
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const PAGES = [
  ["index.html", "index.html"],
  ["dashboard.html", "dashboard.html"],
  ["app.html", "app.html"],
  ["deck.html", "deck.html"],
  ["404.html", "404.html"],
];

if (!existsSync("out/index.html")) {
  console.error("out/ is not built. Run `npm run build` first.");
  process.exit(1);
}
// The old builder still reads `web/*.html`, which are kept for exactly this comparison.
execFileSync(process.execPath, ["scripts/build-site.mjs"], { stdio: "pipe" });

const bodyOf = (html) => {
  const i = html.indexOf("<body");
  const j = html.lastIndexOf("</body>");
  return i === -1 ? html : html.slice(html.indexOf(">", i) + 1, j);
};

/** Everything a framework may legitimately add or reshape, removed. */
function normalise(html) {
  return html
    // The source writes entities, React writes the characters. Same text.
    .replace(/&(ndash|mdash|nbsp|hellip|times|middot|rsquo|lsquo|ldquo|rdquo|amp|lt|gt|quot|larr|rarr|minus|#x27|#39);/gi,
      (_, e) => ({ ndash: "–", mdash: "—", nbsp: " ", hellip: "…", times: "×", middot: "·",
        rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", amp: "&", lt: "<", gt: ">", quot: '"',
        larr: "←", rarr: "→", minus: "−",
        "#x27": "'", "#39": "'" })[e.toLowerCase()])
    .replace(/<script[\s\S]*?<\/script>/gi, "")   // ours are re-emitted; Next adds its own
    .replace(/<style[\s\S]*?<\/style>/gi, "")     // the page stylesheet became a real file
    .replace(/<link\b[^>]*>/gi, "")
    .replace(/<div hidden(?:="")?>(?:<!--[\s\S]*?-->)*<\/div>/gi, "") // React's placeholder
    .replace(/<!--[\s\S]*?-->/g, "")              // comments, and Next's hydration markers
    .replace(/\s+/g, " ")
    .replace(/\s*\/>/g, ">")                      // <br/> vs <br>
    // React closes empty SVG elements (`<rect></rect>`) where the hand-written source
    // self-closed them. Same element, same rendering, different bytes.
    .replace(/<\/(path|rect|circle|ellipse|line|polygon|polyline|stop|use|img|br|hr|input)>/gi, "")
    // JSX trims the whitespace at the start of a line; HTML collapses it. Same rendering,
    // so whitespace against a tag boundary is removed on both sides rather than compared.
    .replace(/>\s+/g, ">")
    .replace(/\s+</g, "<")
    // `hidden` and `hidden=""` are the same attribute.
    .replace(/\s(hidden|disabled|checked|readonly|required|selected|autofocus)=""/gi, " $1")
    // React writes a style object back without the space after the semicolon.
    .replace(/;\s+/g, ";")
    .trim();
}

/** Attribute order differs between a hand-written tag and a rendered one. Sort it. */
function canonicalTags(s) {
  return s.replace(/<([a-zA-Z][-\w]*)((?:\s+[^<>"]*(?:"[^"]*")?)*)\s*>/g, (whole, name, attrs) => {
    const found = [...attrs.matchAll(/([-:\w]+)(?:="([^"]*)")?/g)]
      // `autoComplete` and `autocomplete` are the same attribute to every HTML parser;
      // React serialises the camel form and the hand-written source used the lower one.
      .map((m) => (m[2] === undefined ? m[1].toLowerCase() : `${m[1].toLowerCase()}="${m[2]}"`))
      .sort();
    return `<${name}${found.length ? " " + found.join(" ") : ""}>`;
  });
}

let bad = 0;
for (const [oldFile, newFile] of PAGES) {
  const a = canonicalTags(normalise(bodyOf(readFileSync(`dist/${oldFile}`, "utf8"))));
  const b = canonicalTags(normalise(bodyOf(readFileSync(`out/${newFile}`, "utf8"))));
  if (a === b) {
    console.log(`same   ${newFile}  (${b.length} chars)`);
    continue;
  }
  bad++;
  // Where they first part company, with enough either side to recognise it.
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  console.log(`DIFFER ${newFile}  at char ${i} of ${a.length}/${b.length}`);
  console.log(`  old: …${a.slice(Math.max(0, i - 90), i + 90)}`);
  console.log(`  new: …${b.slice(Math.max(0, i - 90), i + 90)}`);
}
process.exit(bad ? 1 : 0);
