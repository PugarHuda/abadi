/* Render the film in small pieces, then join them.
 *
 * A single `remotion render` of all 5,182 frames is killed part way through on this
 * machine — at three workers it stopped at frame 2,860 with nothing on stdout, at one it
 * died inside the compositor around the same place. The cause is not the film: Remotion's
 * own processes hold about 120 MB, while the box has under a gigabyte free because it runs
 * several other projects' dev servers at the same time. Nothing here can fix that, so the
 * render is built to survive it.
 *
 * Two things make that work. Each part is a fresh process, so whatever accumulates is
 * given back at the end of every part; and the bundle is built ONCE and reused, because
 * re-bundling per part costs more than rendering it. Parts already on disk are skipped, so
 * a kill costs one part and not an hour. Cutting mid-scene is safe — each part starts on a
 * keyframe and the join is a stream copy, so the frames are simply consecutive.
 *
 *   node video/render.mjs           # render what is missing, then join
 *   node video/render.mjs --force   # start over, bundle included
 */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, "assets");
const out = path.join(here, "out");
const bundleDir = path.join(out, "bundle");
const entry = path.join(here, "remotion", "index.ts");

/** Small enough that a part finishes before the machine can starve it. */
const CHUNK = 250;
const CONCURRENCY = 1;
/* Left alone the compositor holds 350 MB of decoded frames per thread — on this box that
 * is the entire budget, spent on frames it has already drawn. */
const VIDEO_CACHE_BYTES = 100_000_000;

/* Run the CLI's JavaScript with this same node, rather than going through npx.
 *
 * Two dead ends got here. `shell: true` makes execFileSync join the arguments into one
 * command line without quoting them, and this repository lives under a path with a space
 * in it, so everything after "Event" became its own token. Dropping the shell and calling
 * `npx.cmd` then fails with EINVAL: since the fix for CVE-2024-27980, Node refuses to
 * spawn a .cmd without a shell at all. Spawning node with an argv array has neither
 * problem. */
const CLI = path.join(here, "..", "node_modules", "@remotion", "cli", "remotion-cli.js");
const remotion = (args) =>
  execFileSync(process.execPath, [CLI, ...args], { stdio: "inherit" });

const timing = JSON.parse(await readFile(path.join(assets, "timing.json"), "utf8"));
const total = timing.durationInFrames;
const force = process.argv.includes("--force");

if (force) await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

/* Skipping work already done is the point of this script; skipping work done against an
 * OLDER script is how it quietly ships the wrong film. `timing.json` is rewritten by every
 * `video:vo` run, so anything on disk older than it was rendered from words that have since
 * changed. Re-render those rather than keep them. */
/* The newest of the timeline AND the footage, not the timeline alone.
 *
 * `remotion bundle` copies BOTH into the bundle, and this guard only ever looked at one of
 * them. Re-filming every shot without touching `timing.json` therefore left the bundle
 * "current" while the footage inside it was the previous take — which is exactly what
 * happened on 2026-09-07: the cursor was added to the capture, nine shots were refilmed, and
 * the render served the old ones back. It fails silently and the film looks fine, which is
 * the worst shape a staleness bug can have. */
const inputs = [
  path.join(assets, "timing.json"),
  ...readdirSync(assets).filter((f) => /^shot-.*\.mp4$/.test(f)).map((f) => path.join(assets, f)),
];
const timelineAt = Math.max(...inputs.map((f) => statSync(f).mtimeMs));
const current = (f) => existsSync(f) && statSync(f).mtimeMs >= timelineAt;

/* The bundle is the one that matters most, and guarding the parts without guarding it was
 * worse than guarding nothing.
 *
 * `remotion bundle` COPIES `timing.json` and every shot into `out/bundle/public/`. A bundle
 * built before the last `video:vo` therefore serves the old timeline, and the composition
 * inside it still declares the old `durationInFrames` — so twenty-one parts were rendered
 * from the previous film while this script counted chunks against the new one, and the run
 * ended on `frame range 5000-5249 is not inbetween 0-5038`. The error was the lucky part:
 * had the new film been the shorter of the two, every part would have rendered "fine" and
 * the join would have produced a finished film of the wrong words.
 *
 * So a stale bundle invalidates everything downstream of it, not just itself. */
if (!current(path.join(bundleDir, "index.html"))) {
  if (existsSync(bundleDir)) {
    console.log("the bundle is older than the timeline — discarding it and every part built from it");
    await rm(out, { recursive: true, force: true });
    await mkdir(out, { recursive: true });
  }
  console.log("bundling");
  remotion(["bundle", entry, "--out-dir", bundleDir, "--public-dir", assets]);
}

const parts = [];
for (let from = 0, i = 0; from < total; from += CHUNK, i++) {
  const to = Math.min(from + CHUNK - 1, total - 1);
  const part = path.join(out, `part-${String(i).padStart(3, "0")}.mp4`);
  parts.push(part);
  if (current(part)) continue;
  console.log(`part ${i}  frames ${from}-${to}`);
  remotion([
    "render", bundleDir, "abadi-demo", part,
    "--frames", `${from}-${to}`,
    "--muted",
    "--concurrency", String(CONCURRENCY),
    `--offthreadvideo-cache-size-in-bytes=${VIDEO_CACHE_BYTES}`,
    "--log", "error",
  ]);
}

/* The voice is rendered once, over the whole timeline, and never cut into parts.
 *
 * It used to come out of each part along with the picture, and joining those was wrong in
 * a way that played back fine for the first minute. AAC codes in blocks of 1024 samples,
 * so a part holding 8.3333s of sound is written as 8.384s — the encoder pads the tail. The
 * concat demuxer starts the next part after the LONGEST stream of the previous one, so
 * every boundary inserted 50.7 ms: the picture froze on its last frame and the voice took
 * a breath it never took. Twenty boundaries, and the film ran 1.07s long with the audio
 * drifting the whole way. Rendering the sound in one pass means there are no seams in it
 * to pad, and the picture is joined with no audio in the files at all, so nothing stretches
 * a part beyond its own frames. */
const audio = path.join(out, "audio.wav");
if (!current(audio)) {
  console.log("voice, one pass over the whole timeline");
  remotion(["render", bundleDir, "abadi-demo", audio, "--codec", "wav", "--log", "error"]);
}

/* Join without re-encoding. Every part came out of the same encoder at the same settings,
 * so a stream copy is exact — re-encoding would be a second generation of loss for
 * nothing. */
const list = path.join(out, "parts.txt");
await writeFile(list, parts.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n"));
const silent = path.join(out, "picture.mp4");
execFileSync(
  "ffmpeg",
  ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", silent],
  { stdio: "inherit" },
);

/* Lay the one-pass voice over the joined picture. The picture is copied, never re-encoded;
 * only the sound is coded here, once, from the lossless render. */
const film = path.join(out, "abadi-demo.mp4");
execFileSync(
  "ffmpeg",
  [
    "-y", "-v", "error",
    "-i", silent,
    "-i", audio,
    "-c:v", "copy",
    "-c:a", "aac", "-b:a", "192k",
    "-shortest", "-movflags", "+faststart",
    film,
  ],
  { stdio: "inherit" },
);

/* Count the frames and look for holes between them.
 *
 * Length alone said something was wrong once and could not say what: the film was 1.07s
 * long with every frame present, because the join had inserted a freeze at each of the
 * twenty part boundaries. So check the two things separately — the count catches a part
 * that is missing or short, and the spacing catches a seam that stretched. */
const probe = (args) => execFileSync("ffprobe", ["-v", "error", ...args, film]).toString();
/* Drop blank lines BEFORE converting. ffprobe ends its output with a newline, and
 * `Number("")` is 0 — not NaN — so a `Number.isFinite` filter keeps that empty line as a
 * frame at timestamp zero. It reported 5040 frames of 5039, last at 0.00s. */
const stamps = probe(["-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0"])
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => Number(line.split(",")[0]))
  .filter((n) => Number.isFinite(n));

const step = 1 / timing.fps;
const seams = stamps
  .map((t, i) => (i === 0 ? 0 : t - stamps[i - 1]))
  .filter((gap) => gap > step * 1.5).length;

console.log(`\n${film}`);
console.log(`${stamps.length} frames of ${total}, last at ${stamps.at(-1).toFixed(2)}s`);

if (stamps.length !== total) {
  console.log(`FRAMES MISSING — expected ${total}; a part is missing or short, delete it and re-run.`);
  process.exitCode = 1;
}
if (seams) {
  console.log(`${seams} FROZEN SEAM(S) — a part is longer than its own frames, so the join`);
  console.log("padded it. Parts must be rendered --muted and the voice muxed on at the end.");
  process.exitCode = 1;
}
if (stamps.length === total && !seams) console.log("continuous, and the voice is one pass");
