/**
 * Wraps the page sources in web/ into complete HTML documents in dist/.
 *
 * The sources are written as page CONTENT — no doctype, no <html>, no <head> —
 * because that is what the artifact renderer expects; it supplies the shell itself.
 * Vercel serves files verbatim, so publishing them raw put the live site into quirks
 * mode with no mobile viewport. One source, two targets, and the wrapper lives here.
 *
 * Run: node scripts/build-site.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const SRC = "web";
const OUT = "dist";
const ORIGIN = "https://abadi-wheat.vercel.app";

const PAGES = {
  "index.html": {
    path: "/",
    description:
      "A vault that quotes both sides of DreamDEX Event Contract markets holding no inventory, and captures the spread with no directional exposure. Live on Somnia Shannon testnet.",
  },
  "dashboard.html": {
    path: "/dashboard",
    description:
      "The working behind Abadi: 2,422 settled markets measured, the live order book with the vault's quote inside it, and the position that filled — with what went wrong and what it cost.",
  },
  "deck.html": {
    path: "/deck",
    description:
      "Ten slides on Abadi: why 2,422 settled markets pointed at market making rather than prediction, and what happened when the vault quoted inside the spread.",
  },
};

/** Pull <title> out of the source so it is never defined in two places. */
function titleOf(html, fallback) {
  const m = html.match(/<title>([^<]*)<\/title>/i);
  return m ? m[1].trim() : fallback;
}

/** Everything the source declares before its first element, minus the title.
 *  Consumes leading head tags one at a time. A single anchored regex stops after
 *  the first match and silently leaves the rest in the body, where a preconnect is
 *  too late to buy anything. */
function splitHead(html) {
  const head = [];
  const leading = /^\s*(<title>[\s\S]*?<\/title>|<link\b[^>]*>|<meta\b[^>]*>)/i;
  let rest = html;
  for (;;) {
    const m = rest.match(leading);
    if (!m) break;
    if (!/^<title/i.test(m[1])) head.push(m[1].trim());
    rest = rest.slice(m[0].length);
  }
  return { head: head.join("\n  "), body: rest };
}

// The mark: one contract split by a price, the two sides always filling the whole.
// Same geometry as web/logo.svg, on an ink field so it survives a light browser
// chrome. Inline so it costs no request.
const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
      `<rect width="32" height="32" fill="#14203A"/>` +
      `<rect x="6" y="6" width="12.4" height="20" fill="#E0A045"/>` +
      `<rect x="18.4" y="6" width="7.6" height="20" fill="#4FA396"/>` +
      `<path d="M18.4 2V30" stroke="#EAE4D6" stroke-width="1" opacity=".5"/>` +
      `</svg>`,
  );

mkdirSync(OUT, { recursive: true });

for (const [file, meta] of Object.entries(PAGES)) {
  const raw = readFileSync(join(SRC, file), "utf8");
  const title = titleOf(raw, "Abadi");
  const { head, body } = splitHead(raw);

  const doc = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <meta name="description" content="${meta.description}">
  <meta name="color-scheme" content="dark">
  <meta name="theme-color" content="#14203A">
  <link rel="icon" href="${FAVICON}">
  <link rel="canonical" href="${ORIGIN}${meta.path}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${meta.description}">
  <meta property="og:url" content="${ORIGIN}${meta.path}">
  <meta name="twitter:card" content="summary_large_image">
  ${head}
</head>
<body>
${body.trim()}
</body>
</html>
`;

  writeFileSync(join(OUT, file), doc);
  console.log(`${file} -> ${OUT}/${file}  (${doc.length} bytes)`);
}

// Carry over anything else the pages reference.
for (const f of readdirSync(SRC)) {
  if (PAGES[f]) continue;
  if (statSync(join(SRC, f)).isDirectory()) continue;
  if (![".json", ".svg", ".png", ".webp", ".ico", ".css", ".js"].includes(extname(f))) continue;
  copyFileSync(join(SRC, f), join(OUT, f));
  console.log(`copied ${f}`);
}
