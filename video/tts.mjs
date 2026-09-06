/* Voice-over and subtitles, in one pass.
 *
 * edge-tts speaks each scene and, for the same request, hands back a WebVTT cue per word
 * boundary from the synthesiser itself. That is the whole reason this pipeline has no
 * forced-alignment step and no Whisper: the timings are not estimated from the audio, they
 * are what the voice actually did. Subtitles land on the word.
 *
 *   node video/tts.mjs          # speak every scene
 *   node video/tts.mjs --check  # print durations and the total, speak nothing new
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FPS, RATE, VOICE, scenes, spoken } from "./script.mjs";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, "assets");

/* A caption line, not a word: seven words or forty-two characters, whichever comes first,
 * and always broken at a sentence end so a full stop never opens the next card. */
const MAX_WORDS = 9;
const MAX_CHARS = 52;

/* A WordBoundary carries the spoken word and nothing else — no comma, no full stop, no
 * dash. Captions built straight from them run sentences together ("a day Liquidity") and
 * give the card-breaking rule below nothing to break on. The words arrive in order and in
 * the order they appear in the source, so walk the original text alongside them and take
 * back the punctuation each one was written with. */
function repunctuate(text, words) {
  let cursor = 0;
  return words.map((w) => {
    const at = text.indexOf(w.word, cursor);
    if (at < 0) return w;
    let end = at + w.word.length;
    while (end < text.length && /[.,;:!?)\]"”’]/.test(text[end])) end++;
    // An em dash is spaced in this script and is a held breath, not stray punctuation.
    if (text.startsWith(" —", end)) end += 2;
    cursor = end;
    return { ...w, word: text.slice(at, end) };
  });
}

function toCaptions(words) {
  const cards = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    cards.push({
      text: cur.map((w) => w.word).join(" "),
      start: cur[0].start,
      end: cur[cur.length - 1].end,
    });
    cur = [];
  };
  for (const w of words) {
    cur.push(w);
    const chars = cur.map((c) => c.word).join(" ").length;
    // An em dash is a held breath in this script; let it end a card too.
    const breaks = /[.!?]$|—$/.test(w.word);
    if (breaks || cur.length >= MAX_WORDS || chars >= MAX_CHARS) flush();
  }
  flush();
  return cards;
}

async function duration(file) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  return Number(stdout.trim());
}

const stamp = (t, sep = ",") => {
  const h = String(Math.floor(t / 3600)).padStart(2, "0");
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
  const s = String(Math.floor(t % 60)).padStart(2, "0");
  const ms = String(Math.round((t % 1) * 1000)).padStart(3, "0");
  return `${h}:${m}:${s}${sep}${ms}`;
};

/* The two functions above are the only real logic in the pipeline, and both fail quietly:
 * a broken repunctuate still produces captions, just unreadable ones. Offline, no network.
 *   node video/tts.mjs --self-check
 */
if (process.argv.includes("--self-check")) {
  const { strict: assert } = await import("node:assert");
  const bare = (s) => s.split(" ").map((word) => ({ word, start: 0, end: 0 }));

  const text = "It expires — sixty seconds, a day. It isn't liquidity.";
  const got = repunctuate(text, bare("It expires sixty seconds a day It isn't liquidity")).map(
    (w) => w.word,
  );
  assert.deepEqual(got, [
    "It", "expires —", "sixty", "seconds,", "a", "day.", "It", "isn't", "liquidity.",
  ]);

  // A word the synthesiser reports but the source does not contain must not derail the walk.
  const odd = repunctuate("a b.", bare("a zzz b")).map((w) => w.word);
  assert.deepEqual(odd, ["a", "zzz", "b."]);

  // A full stop ends a card even when the caps are nowhere near.
  const cards = toCaptions(bare("One two. Three four five"));
  assert.equal(cards.length, 2);
  assert.equal(cards[0].text, "One two.");

  // …and the caps end one when the punctuation never comes.
  const long = toCaptions(bare(Array(20).fill("word").join(" ")));
  assert.ok(long.length >= 3, `expected the caps to break 20 words, got ${long.length} card(s)`);
  assert.ok(long.every((c) => c.text.length <= MAX_CHARS + 8));

  console.log("self-check ok");
  process.exit(0);
}

const check = process.argv.includes("--check");

await mkdir(assets, { recursive: true });
const out = [];
let clock = 0;
const srt = [];

for (const scene of scenes) {
  const mp3 = path.join(assets, `vo-${scene.id}.mp3`);
  const meta = path.join(assets, `vo-${scene.id}.json`);
  const text = spoken(scene);

  if (!check && !(existsSync(mp3) && existsSync(meta))) {
    process.stdout.write(`speaking  ${scene.id} … `);
    await run("python", [path.join(here, "speak.py"), text, VOICE, RATE, mp3, meta]);
    process.stdout.write("ok\n");
  }

  const words = repunctuate(text, JSON.parse(await readFile(meta, "utf8")));
  const captions = toCaptions(words);
  const speech = await duration(mp3);
  const total = speech + scene.pad;

  for (const c of captions) {
    srt.push(
      `${srt.length + 1}\n${stamp(clock + c.start)} --> ${stamp(clock + c.end)}\n${c.text}\n`,
    );
  }

  /* A terminal scene is drawn, not filmed, so its text has to reach the browser bundle.
   * Carrying it in timing.json keeps the React component synchronous — no staticFile
   * fetch, no delayRender, no way for the render to hang waiting on a file read. */
  const shot = { ...scene.shot };
  if (shot.type === "terminal") {
    shot.lines = (await readFile(path.join(assets, shot.src), "utf8")).replace(/\s+$/, "").split(/\r?\n/);
  }

  out.push({
    id: scene.id,
    chapter: scene.chapter,
    shot,
    audio: `vo-${scene.id}.mp3`,
    speech,
    pad: scene.pad,
    durationInFrames: Math.ceil(total * FPS),
    captions,
    words: words.length,
  });

  console.log(
    `${scene.id.padEnd(13)} ${speech.toFixed(2)}s speech  +${scene.pad}s pad` +
      `  ${String(words.length).padStart(3)} words  ${captions.length} cards`,
  );
  clock += total;
}

const frames = out.reduce((n, s) => n + s.durationInFrames, 0);
const runtime = frames / FPS;

await writeFile(
  path.join(assets, "timing.json"),
  JSON.stringify({ fps: FPS, durationInFrames: frames, scenes: out }, null, 2),
);
await writeFile(path.join(assets, "abadi-demo.srt"), srt.join("\n"), "utf8");

const words = out.reduce((n, s) => n + s.words, 0);
console.log(
  `\nruntime ${Math.floor(runtime / 60)}:${String(Math.round(runtime % 60)).padStart(2, "0")}` +
    `  (${frames} frames)  ${words} words  ${Math.round(words / (runtime / 60))} wpm`,
);
if (runtime > 180) console.log("OVER THREE MINUTES — the submission allows 2–3. Trim.");
