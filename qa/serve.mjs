/** Static server over the framework's export, mirroring what Vercel serves.
 *
 *  QA has to run against the same routing production uses, or it proves nothing. Next writes
 *  `/dashboard` as `out/dashboard.html`, so the extension-then-index resolution below is what
 *  Vercel's own handling of a static export does, and the headers come from `vercel.json`
 *  rather than a copy of it. */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = "out";  // the framework's static export
const PORT = Number(process.env.PORT ?? 4321);

/* The security headers, read from `vercel.json` rather than copied.
 *
 * This server exists to mirror production, and a hand-copied header table is a mirror that
 * drifts the first time somebody edits one side. So there is one source: the same file
 * Vercel reads. If the CSP here and the CSP in production ever disagree, it is because the
 * file changed, and both changed together.
 *
 * It matters because `frame-ancestors 'none'` is a real fix, not decoration — `/app` was
 * demonstrably loadable inside a cross-origin iframe with every transaction button live, and
 * the test that holds that closed has to run against the same policy production serves. */
const VERCEL = JSON.parse(readFileSync("vercel.json", "utf8"));
const SECURITY_HEADERS = Object.fromEntries(
  (VERCEL.headers ?? [])
    .filter((h) => h.source === "/(.*)")
    .flatMap((h) => h.headers)
    .map((h) => [h.key, h.value]),
);
/** Browsers enforce the stylesheet MIME type strictly: served as octet-stream, a .css
 *  file is fetched, ignored, and reported nowhere. This table had .html/.json/.svg only,
 *  so the first shared stylesheet the site ever had rendered as an unstyled page in QA
 *  while production served it fine. Scripts and images are here for the same reason —
 *  they survive a wrong type today by sniffing, which is luck, not a contract. */
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".xml": "application/xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

async function resolve(url) {
  let clean = decodeURIComponent(url.split("?")[0]);
  // The one rewrite production has. Kept here for the same reason as the headers.
  for (const r of VERCEL.rewrites ?? []) if (clean === r.source) clean = r.destination;
  for (const p of [clean, clean + ".html", join(clean, "index.html")]) {
    const f = join(ROOT, p);
    try {
      if ((await stat(f)).isFile()) return f;
    } catch {}
  }
  return null;
}

/** Send one file, with the length on it.
 *
 *  `content-length` is not decoration here. Without it Node falls back to chunked transfer,
 *  and `qa/perf.spec.ts` builds its page-weight budget by summing `content-length` off each
 *  response — so every byte counted as zero, the total came to 0, and `expect(0).toBeLessThan
 *  (102400)` passed on any page of any size. A budget that cannot fail is not a budget. */
async function send(res, status, file) {
  const body = await readFile(file);
  res.writeHead(status, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "content-length": body.length,
    ...SECURITY_HEADERS,
  });
  res.end(body);
}

createServer(async (req, res) => {
  const f = await resolve(req.url ?? "/");
  if (f) return send(res, 200, f);

  /* Vercel serves dist/404.html for an unknown path, with a 404 status. Answering "not
     found" in plain text meant the site's own 404 page was only ever reached by asking for
     it by name, so nothing checked that a genuine miss renders it. */
  try {
    return await send(res, 404, join(ROOT, "404.html"));
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
}).listen(PORT, () => console.log(`serving ${ROOT} on http://localhost:${PORT}`));
