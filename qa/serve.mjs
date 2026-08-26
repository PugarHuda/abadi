/** Static server that mirrors the Vercel config: outputDirectory dist, cleanUrls on.
 *  QA has to run against the same routing production uses, or it proves nothing. */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";

const ROOT = "dist";
const PORT = Number(process.env.PORT ?? 4321);
const TYPES = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml" };

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
