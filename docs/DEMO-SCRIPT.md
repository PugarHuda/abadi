# Demo video — how it is made, and the facts it states

**Runtime 2:56. The submission allows 2–3 minutes, so this is close to the ceiling: adding a sentence now means cutting one.**

The film is not recorded by hand any more. It is built by a pipeline, from one script, and
the whole thing rebuilds with:

```
npm run video          # voice, then footage, then render
```

Output: `video/out/abadi-demo.mp4`, plus `video/assets/abadi-demo.srt` for the upload.

**The script of record is `video/script.mjs`.** Every line of voice-over and the shot it
plays over live there together. Nothing else decides a duration: the voice is synthesised
first, its length measured, and the camera then films each shot for exactly that long. To
retime the film, change the words.

## The four stages

| Stage | Command | What it does |
|---|---|---|
| Voice | `npm run video:vo` | edge-tts speaks each scene. The same request returns a WordBoundary per word, so subtitles land on the word — there is no alignment step and no Whisper. Writes `timing.json` and the `.srt`. |
| Footage | `npm run video:shots` | Playwright drives the live site and the Shannon explorer, films each shot at 1920×1080, and trims the page-load wait off the head. |
| Render | `npm run video:render` | Remotion lays voice, footage and captions on one timeline. |
| Studio | `npm run video:studio` | Opens the film in Remotion's editor for a look before rendering. |

`node video/tts.mjs --self-check` exercises the caption logic offline — punctuation is
re-attached to the synthesiser's bare words, and cards break on a full stop before they
break on a length cap. Remotion is free for individuals and companies of three or fewer;
this is a solo entry, which is the licence it ships under.

Six things in this pipeline are load-bearing and should not be simplified away:

- **`video:shots` REUSES footage it already has** — it prints `have <id>` and moves on — and
  **`video:render` only checked `timing.json` when deciding whether its bundle was stale.**
  Both are sensible alone and together they hid a whole re-record: on 2026-09-07 the capture
  gained a pointer, the voice-over changed, and the film came out with the new words over the
  OLD footage, because nothing re-filmed and nothing invalidated the bundle that had the old
  shots copied inside it. Use `node video/capture.mjs --force` when the capture itself
  changes, and the render's staleness check now takes the newest of `timing.json` *and* every
  `shot-*.mp4`. A staleness bug that produces a film which looks fine is the worst shape one
  can have.

- **The pointer is drawn by the page, not by the recorder.** Playwright's video captures the
  page and nothing else: `page.mouse` and `page.click` dispatch real events and leave no mark
  on screen, so every shot showed a deck advancing and a panel scrolling with nothing visibly
  doing it. `video/cursor.mjs` injects a cursor element before any page script runs and moves
  it from the same `mousemove` events a hand would produce — the clicks are Playwright's own,
  only the picture of the pointer is drawn. Two things it has to get right: the page is scaled
  with CSS `zoom` for filming, so the drawn pointer divides the event coordinates back out,
  and `boundingBox()` is ALREADY in the zoomed space, so a click must not be scaled again —
  doing that sent the click past the button and the deck never advanced.
- **A panel is checked before it is filmed.** The dashboard's own `data-state` has to read
  `live`. The indexer fails about one call in five and the explorer went down entirely on
  the 2nd; a shot of a panel reading `unreachable` is not footage of a live dashboard.
- **The lead-in is cut.** Recording starts when the browser context does, so the wait for
  the chain to answer sits at the head of the file — 10 seconds of it on the explorer. It
  is trimmed in ffmpeg, or the camera move lands after the voice has stopped describing it.
- **A keyframe every half second, and no scene-cut detection** (`-g 15 -keyint_min 15
  -sc_threshold 0`). Left alone, x264 puts one every 250 frames and skips them entirely on
  footage that barely moves — which is what a screen recording is. Two shots came out with
  **two keyframes across their whole length**, and Remotion's compositor, which seeks these
  files once per frame, failed outright on both: *"No frame found at position"*, once mid-
  render and once on an audio-only pass. Every frame is present and ffprobe reads them all;
  there is simply nothing near the requested time to decode from.
- **Parts are rendered `--muted` and the voice is muxed on at the end.** The film is
  rendered in chunks, and the chunks used to carry their own audio. AAC codes in blocks of
  1024 samples, so a part holding 8.3333s of sound is written as 8.384s. `ffmpeg -f concat`
  starts the next part after the *longest* stream of the previous one, so every boundary
  inserted 50.7 ms of nothing: the picture froze on its last frame and the voice took a
  breath it never took. Twenty boundaries, a film 1.07s long, drifting the whole way. The
  render's own check now counts frames and looks for holes between them, and names which of
  the two went wrong.

## What changed on each re-record, and why

This file says to re-read every live figure before a render. It has changed the words every
single time, which is the argument for the rule.

**On 2026-09-04**, against a shot list written on the 2nd: the vault had crossed back below
par, six completions had become nine, thirty-four refusals had become sixty-four, and the
book panel was empty — `data-state="idle"`, the guard refusing every spread on offer. The
scene became what was on the screen rather than what had been written for it.

**On 2026-09-06**, two days later, two lines came out for being *false* rather than stale:

- **"We're the only one putting capital in"**, and the line that followed from it, **"the
  only one who can be asked whether the book got better."** True when 13 projects had
  entered. By the 6th there were **34**, and HOUSE, DreamVault, TEMPO, HedgePulse and
  Perennis all put capital into this venue — HOUSE on the same no-inventory mechanism,
  described almost word for word. The measurement is still ours alone; being the only maker
  is not. **Never restore a superlative about the field without re-reading the field.**
- **The impact line said "every window we've ever quoted."** The measurement covers 70
  windows and is dated 31 August; there are 203 episodes now. It says "seventy of the
  windows we've quoted", which stays true however many there are.
- The numbers moved hard: depositors from −0.51% to **−2.03%**, nine completions to
  **fourteen**, and carrying a naked leg got *worse* rather than better.
- **The `capital` scene no longer describes the panel's state at all.** Saying "not a cent
  of it is quoting" was true for the run that filmed it and false for the next one, which
  is a line that has to be rewritten on every record. It talks about the record instead,
  and the picture shows whichever state the vault is in.

## Facts the film states, as of 2026-09-06

Get these wrong and a judge who checks discounts everything else. **Re-read them before any
re-render**, and re-run `npm run video:vo` for the scenes whose numbers moved.

**These are the current readings, not the film's.** The rendered cut carries the 2026-09-06
morning ledger; where a row differs it says so. A film is a recording of a run and is allowed
to be a day old — this table is the checklist for the next one, so it tracks the chain.

| Claim | The number |
|---|---|
| Unit tests | **148** passing (149 total; the fork suite skips without `FORK_RPC`). The voice says it and `video/assets/forge-test.txt` shows it — the drift from 146 closed on the 2026-09-07 re-render. |
| Third-party conformance | a16z `ERC4626Test`, **26/26** fuzzed properties — `test/LiquidityVault.conformance.t.sol` |
| Fork tests against the real venue | **9**, all passing — `node scripts/fork-test.ts` |
| Coverage | 97.28% of lines, 43/43 functions on `LiquidityVault.sol` |
| Per share | **0.972372** (film: 0.979700) |
| Depositors, vs. par | **−264.30 tUSDC (−2.76%)** — below par (film: −194.20, −2.03%) |
| Realised, every closed episode | −403.50 on 19,544.25 (−2.06%) |
| Episodes | **203** across 13 vaults (film: 193) |
| Fill shape | 156 complete · 41 one-sided · 2 no fill · 4 open — **21% adverse** |
| One-sided: carried vs completed | 26 carried at −30.12%, worst −100% · **14 completed at −0.98%**, worst −3.47% — `docs/evidence/completing-2026-09-06.md` |
| Completion refusals | **126** (median pair 1.209, cheapest refused 1.061) |
| Venue spread, without us vs with | 0.0249 vs 0.0192 over **70 windows, measured 2026-08-31** — tighter on 66, wider on **none**. Not "every window"; there are 203 episodes now |
| SDK issues filed | 16 |
| Live vault | `0xFd9c93581ADD42B9B13ba5550542Fc7315775cD9` — `attest.ts` says **MISMATCH** since `8cd803e`: the source is ahead of the chain by two guards, on purpose. The film does not state this either way, so nothing in it is wrong. |
| Reactivity settle, on chain | `0x2f75001ea73bd66cf62649841542a2d8b74cad22afa1513e5e6463730a009f50` |

**Do not say "profitable".** Per share is below par and realised across every vault is
negative. One in five filled quotes goes adverse against the roughly one in eleven the
spread needs. Say what the numbers say — the film does.

**Do not name another submission** *in the film*. The rivals are named above and in
`SUBMISSION.md` because our own claims have to be checked against them; none of those names
is spoken on screen, and the film makes no comparison at all now that it cannot honestly
make the one it used to. Abadi has had its own fair-value model since the 31st, backtested
against 1,276 resolved windows, where it *ties* the book. That is a finding, not a gap, and
the film does not lead with it.

## The question you will get, and the answer

> *"Your operator key trades. What stops it running off with the money?"*

Cannot transfer, can trade. The vault holds custody and the key cannot reach it — that part
is absolute. What the key can do is quote badly, so the bound on that is on chain too:
`maxQuoteNotional` caps one quote and `maxDeployedBps` caps the whole book as a fraction of
NAV, both governor-set. Deposits also carry a 300-second redeem delay, capped at an hour, so
the settle sandwich costs an attacker time they have to be right through.
