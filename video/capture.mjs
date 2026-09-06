/* The footage: a real browser, on the real site, filmed for exactly as long as the voice
 * needs. Nothing here is a mockup or a still dressed up as motion — the numbers on screen
 * are the ones the page fetched from Shannon while the camera was running, which is the
 * only reason the film is allowed to claim they are live.
 *
 * Durations come from assets/timing.json, so run tts.mjs first.
 *
 *   node video/capture.mjs            # film every shot that is missing
 *   node video/capture.mjs --only id  # refilm one scene
 *   node video/capture.mjs --force    # refilm everything
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { HEIGHT, SITE, WIDTH } from "./script.mjs";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, "assets");
const raw = path.join(assets, "raw");

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const force = args.includes("--force");

const EXPLORER = "https://shannon-explorer.somnia.network";
/* The site's measure is 1020px. Filmed in a 1920px-wide viewport that column fills half
 * the frame and the rest is bare paper. Shrinking the viewport instead does not work:
 * recordVideo.size pads a smaller viewport into the corner of the canvas rather than
 * scaling it up. CSS zoom on the root is the one that reflows — the layout viewport
 * becomes 1280 wide while the frame stays a full 1920 physical pixels. */
const ZOOM = 1.5;
/* The indexer fails roughly one call in five and the explorer went down entirely on the
 * 2nd. A shot of a panel reading "unreachable" is not footage of a live dashboard, so
 * every page load is checked and retried before the camera is allowed to keep it. */
const LOAD_TRIES = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Scroll the way a hand does — over a second and a half, eased, not teleported. */
async function glideTo(page, selector, ms = 1500) {
  await page.evaluate(
    async ([sel, dur]) => {
      const el = document.querySelector(sel);
      if (!el) return;
      /* Do not compute the destination by hand. Under the CSS zoom this capture applies,
       * getBoundingClientRect reports in the zoomed space while scrollY is in the layout
       * space, and the two disagree by exactly the zoom factor — which is how the book
       * shot came back still sitting at the top of the page. Let the browser pick the
       * scroll position, read it back, and animate to the number it chose. */
      const from = window.scrollY;
      el.scrollIntoView({ block: "center" });
      const to = window.scrollY;
      window.scrollTo(0, from);
      const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
      const t0 = performance.now();
      await new Promise((done) => {
        const step = (now) => {
          const t = Math.min(1, (now - t0) / dur);
          window.scrollTo(0, from + (to - from) * ease(t));
          t < 1 ? requestAnimationFrame(step) : done();
        };
        requestAnimationFrame(step);
      });
    },
    [selector, ms],
  );
}

/** A steady downward crawl, the way you read a log you are pointing at. */
async function drift(page, px, ms) {
  await page.evaluate(
    async ([distance, dur]) => {
      const from = window.scrollY;
      const t0 = performance.now();
      await new Promise((done) => {
        const step = (now) => {
          const t = Math.min(1, (now - t0) / dur);
          window.scrollTo(0, from + distance * t);
          t < 1 ? requestAnimationFrame(step) : done();
        };
        requestAnimationFrame(step);
      });
    },
    [px, ms],
  );
}

/** True once the panel has real numbers in it rather than "loading" or "unreachable". */
async function isLive(page, selector) {
  return page
    .evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const state = el.getAttribute("data-state");
      // Panels without the attribute are static prose and are always ready.
      return state === null || state === "live";
    }, selector)
    .catch(() => false);
}

async function settle(page, needs) {
  if (!needs) return true;
  for (let i = 0; i < 40; i++) {
    if (await isLive(page, needs)) return true;
    await sleep(500);
  }
  return false;
}

async function film(browser, scene, seconds) {
  const dir = path.join(raw, scene.id);
  await rm(dir, { recursive: true, force: true });

  const shot = scene.shot;
  const url =
    shot.type === "explorer"
      ? // Land on the log list directly: the events are the point of the shot.
        `${EXPLORER}/tx/${shot.tx}?tab=logs`
      : shot.type === "deck"
        ? `${SITE}/deck`
        : `${SITE}${shot.path}`;

  for (let attempt = 1; attempt <= LOAD_TRIES; attempt++) {
    const context = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      recordVideo: { dir, size: { width: WIDTH, height: HEIGHT } },
      deviceScaleFactor: 1,
      reducedMotion: "no-preference",
    });
    const page = await context.newPage();
    // A scrollbar and a caret are furniture the film does not need.
    await page.addStyleTag({ content: "::-webkit-scrollbar{display:none}" }).catch(() => {});

    /* Recording begins the moment the context exists, so everything spent waiting for the
     * chain to answer is at the head of the file. Note where the wait ended and cut it
     * off in ffmpeg — otherwise the film opens on a page that has not loaded yet and the
     * camera move lands after the voice has stopped talking about it. */
    const t0 = Date.now();

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      // The explorer is someone else's layout, and at 1.5 a log row is mostly hex.
      const zoom = shot.type === "explorer" ? 1.15 : ZOOM;
      await page.addStyleTag({
        content:
          `html{zoom:${zoom}}` +
          "::-webkit-scrollbar{width:0;height:0}*{caret-color:transparent!important}",
      });
      await sleep(1200); // fonts, first paint, and the reflow the zoom forces

      if (shot.type === "explorer") {
        // Blockscout is a heavy client render; the log rows arrive well after the HTML.
        await page
          .waitForFunction(() => /Topics|Log index/i.test(document.body.innerText), {
            timeout: 40_000,
          })
          .catch(() => console.log(`  ${scene.id}: log rows never appeared`));
        await sleep(1500);
      }

      const ready = await settle(page, shot.needs);
      if (!ready && attempt < LOAD_TRIES) {
        console.log(`  ${scene.id}: panel never went live, retry ${attempt}/${LOAD_TRIES}`);
        await context.close();
        await rm(dir, { recursive: true, force: true });
        await sleep(3000);
        continue;
      }
      if (!ready) console.log(`  ${scene.id}: WARNING filmed without a live panel`);

      // The camera is rolling from goto; everything below is the shot itself.
      const started = Date.now();
      if (shot.type === "deck") {
        for (let i = 0; i < shot.slide; i++) {
          await page.click("#next");
          await sleep(260);
        }
        // The deck's own pager is navigation furniture, not the slide. Retire it once
        // we have arrived, or every shot carries a pair of arrows in the corner.
        await page.addStyleTag({
          content: "#prev,#next,.pager{opacity:0!important;transition:opacity .4s}",
        });
        await sleep(600);
      } else if (shot.type === "explorer") {
        // Read down through the log list rather than jumping into the middle of it —
        // the events are the evidence, and a cut that lands on raw topic hex shows none.
        await sleep(700);
        await drift(page, 1500, seconds * 1000);
      } else if (shot.anchor) {
        await sleep(900);
        await glideTo(page, shot.anchor, 1800);
      }

      // Hold until the voice is done, plus a tail so Remotion never runs out of frames.
      const held = (Date.now() - started) / 1000;
      await sleep(Math.max(0, (seconds + 1.5 - held) * 1000));
      await context.close();

      const webm = path.join(dir, (await import("node:fs")).readdirSync(dir)[0]);
      const out = path.join(assets, `shot-${scene.id}.mp4`);
      const leadIn = (started - t0) / 1000;
      /* A keyframe every half second, and no scene-cut detection.
       *
       * x264 left alone puts a keyframe every 250 frames and skips one entirely on
       * footage that barely moves, which is what a screen recording is: shot-problem and
       * shot-reactivity came out with TWO keyframes across their whole length. Remotion's
       * compositor seeks these files per frame, and on both of those it failed outright —
       * "No frame found at position", once mid-render and once on an audio-only pass. The
       * file is not broken and ffprobe reads every frame; there is simply nothing near the
       * requested time to decode from. Dense keyframes cost a few megabytes on footage
       * this static and make every seek land next to one.
       *
       * -fps_mode cfr because the source is a browser recording, which only emits a frame
       * when the page changes. Without it the "-r 30" above is a request, not a promise. */
      await run("ffmpeg", [
        "-y",
        "-ss", leadIn.toFixed(2),
        "-i", webm,
        "-r", "30", "-fps_mode", "cfr",
        "-vf", `scale=${WIDTH}:${HEIGHT}:flags=lanczos`,
        "-c:v", "libx264", "-preset", "slow", "-crf", "18",
        "-g", "15", "-keyint_min", "15", "-sc_threshold", "0",
        "-pix_fmt", "yuv420p", "-an",
        out,
      ]);
      await rm(dir, { recursive: true, force: true });
      console.log(`  cut ${leadIn.toFixed(1)}s of loading off the head`);
      return out;
    } catch (err) {
      await context.close().catch(() => {});
      await rm(dir, { recursive: true, force: true });
      if (attempt === LOAD_TRIES) throw err;
      console.log(`  ${scene.id}: ${err.message.split("\n")[0]} — retry ${attempt}`);
      await sleep(3000);
    }
  }
}

const timing = JSON.parse(await readFile(path.join(assets, "timing.json"), "utf8"));
await mkdir(raw, { recursive: true });

for (const scene of timing.scenes) {
  if (scene.shot.type === "terminal") continue; // drawn by Remotion, not filmed
  if (only && scene.id !== only) continue;
  const out = path.join(assets, `shot-${scene.id}.mp4`);
  if (existsSync(out) && !force && !only) {
    console.log(`have      ${scene.id}`);
    continue;
  }
  const seconds = scene.durationInFrames / timing.fps;
  console.log(`filming   ${scene.id}  ${seconds.toFixed(1)}s  ${scene.shot.type}`);
  const browser = await chromium.launch();
  try {
    await film(browser, scene, seconds);
    console.log(`  wrote shot-${scene.id}.mp4`);
  } finally {
    await browser.close();
  }
}
await rm(raw, { recursive: true, force: true }).catch(() => {});
console.log("\nfootage ready");
