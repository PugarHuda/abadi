/** Static server that mirrors the Vercel config: outputDirectory dist, cleanUrls on.
 *  QA has to run against the same routing production uses, or it proves nothing. */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";

const ROOT = "dist";
const PORT = Number(process.env.PORT ?? 4321);
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
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

async function resolve(url) {
  const clean = decodeURIComponent(url.split("?")[0]);
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
