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

createServer(async (req, res) => {
  const f = await resolve(req.url ?? "/");
  if (!f) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "content-type": TYPES[extname(f)] ?? "application/octet-stream" });
  res.end(await readFile(f));
}).listen(PORT, () => console.log(`serving ${ROOT} on http://localhost:${PORT}`));
