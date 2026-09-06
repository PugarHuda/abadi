/* The demo film, as data.
 *
 * One scene = one line of voice-over plus the shot it plays over. Everything downstream
 * reads this file: tts.mjs speaks the `vo`, capture.mjs films the `shot` for exactly as
 * long as the speech turned out to be, and the Remotion composition lays the two together.
 * Nothing anywhere else decides a duration — the voice does, and the picture follows it.
 *
 * Every figure spoken here was re-read from the chain on 2026-09-06. DEMO-SCRIPT.md says
 * to do that on the morning of the record and it is not ceremony — it has changed the
 * words every single time. Since the 4th: depositors went from down half a percent to down
 * two, nine completions became fourteen, and carrying a naked leg got worse rather than
 * better. Numbers in `vo` are spelled the way they should be said.
 *
 * Two lines were also cut for being FALSE rather than stale, and the reason belongs here.
 * They said Abadi was "the only one putting capital in" and therefore "the only one who can
 * be asked whether the book got better". That was true when 13 projects had entered. By the
 * 6th there were 31, and HOUSE, DreamVault, TEMPO, HedgePulse and Perennis all put capital
 * into this venue — HOUSE on the same no-inventory mechanism, described almost word for
 * word. The measurement is still ours alone; being the only maker is not. Never restore a
 * superlative about the field without re-reading the field. */

export const VOICE = "en-US-AndrewMultilingualNeural";
/* DEMO-SCRIPT.md says speak slower than feels natural, and the first cut obeyed it at -6%:
 * 121 words a minute and a four-minute-fifteen film, against a submission that allows
 * three. Pace came out of the word count instead, which is the right place to take it
 * from. +12% then came out at 166 wpm, which is hurried for numbers a judge has to catch;
 * this lands near 162 and a 2:56 film — close enough to the three-minute ceiling that a new sentence has to displace an old one. */
export const RATE = "+8%";
export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;

export const SITE = "https://abadi-wheat.vercel.app";
export const VAULT = "0xFd9c93581ADD42B9B13ba5550542Fc7315775cD9";
export const SETTLE_TX =
  "0x2f75001ea73bd66cf62649841542a2d8b74cad22afa1513e5e6463730a009f50";

/* `pad` is silence held after the line, in seconds. It is where a beat goes — the ones
 * DEMO-SCRIPT.md marks with *hold* and *beat*. Without it every cut lands on a breath. */
export const scenes = [
  {
    id: "problem",
    chapter: "The problem",
    pad: 0.7,
    shot: { type: "deck", slide: 1 },
    vo: `Every prediction market on DreamDEX expires — sixty seconds, fifteen minutes,
         a day. Liquidity you have to rebuild every window isn't liquidity. So we built a
         vault that outlives the markets it quotes.`,
  },
  /* This scene was written to be a shot of our quote resting in the venue's book, and on
   * the morning of the first record the book panel was empty: `data-state="idle"`, nothing
   * quoting, the guard refusing every spread on offer. The line was rewritten to say so,
   * because filming it and claiming otherwise is the one thing this project cannot do.
   *
   * It now says neither. Describing the panel's state in the voice-over means the words
   * are only true for the run that filmed them — that line had to be rewritten on the
   * next record too, when the vault was quoting again. The line talks about the record
   * instead, which is true in either state, and the picture can show whichever it is. */
  {
    id: "capital",
    chapter: "Real capital, on the venue",
    pad: 0.5,
    shot: { type: "page", path: "/dashboard", anchor: "#live", needs: "#live" },
    vo: `This is the vault, live. Nine and a half thousand tUSDC of depositor capital, and a
         hundred and ninety-three quotes placed inside this venue's own book — real money,
         at prices it had to honour. Not a reading of the venue. A position in it.`,
  },
  {
    id: "impact",
    chapter: "Seventy windows, rebuilt twice",
    pad: 1.0,
    shot: { type: "deck", slide: 5 },
    vo: `Which means we can be asked whether the book got better. We rebuilt seventy of the
         windows we've quoted, twice, from the venue's own order rows — once with our
         orders in, once with them taken out. Twenty-three percent narrower with us in it.
         Tighter on sixty-six of seventy, wider on none.`,
  },
  {
    id: "custody",
    chapter: "What the operator key cannot do",
    pad: 0.5,
    shot: { type: "deck", slide: 7 },
    vo: `BinaryPool has no operator gate: a bot key that can trade can also withdraw. Ours
         owns its own orders instead. The operator key picks a price and a size — it cannot
         move a token, and there is no function that would let it.`,
  },
  {
    id: "tests",
    chapter: "forge test",
    pad: 0.7,
    shot: { type: "terminal", src: "forge-test.txt", cmd: "forge test" },
    // The suite is a16z's `ERC4626Test`; the film says what it IS rather than who wrote it,
    // because "a-sixteen-z" read aloud is a puzzle. README and DEMO-SCRIPT name it.
    vo: `A hundred and forty-six tests, nine against the real venue on a fork, and every
         one of the twenty-six properties in an independent ERC-4626 conformance suite —
         the standard's rules, not ours. Ninety-seven percent line coverage on the vault,
         and all forty-three of its functions.`,
  },
  {
    id: "reactivity",
    chapter: "Nobody called this",
    pad: 0.8,
    shot: { type: "explorer", tx: SETTLE_TX },
    vo: `A window expired at seventeen hundred UTC. No bot ran, nobody called anything.
         Somnia's reactivity precompile woke the vault at the second it was armed for, and
         it settled its own position.`,
  },
  {
    id: "honest",
    chapter: "The number that was wrong",
    pad: 0.8,
    shot: { type: "page", path: "/dashboard", anchor: "#pnlChart", needs: "#ledger" },
    vo: `Now the uncomfortable part. This project once published a two point three seven
         percent return. That number was wrong: the ledger summed the episodes that closed
         into a complete set and dropped the ones that went one-sided, so it could not
         produce a loss. We found it ourselves and published the correction.`,
  },
  {
    id: "completing",
    chapter: "Buying the missing side",
    pad: 0.8,
    shot: { type: "deck", slide: 6 },
    vo: `Today, honestly: depositors are down two percent, and one in five filled quotes
         goes adverse. That's the real risk — one leg fills, the market walks away from the
         other, and the vault holds a direction worth one or nothing. Twenty-six of those,
         carried to settlement, averaged minus thirty percent, with a minus one hundred in
         them. So the vault stopped carrying them: it buys the missing side, and the pair is
         worth exactly one either way. Fourteen so far, averaging minus one percent, worst
         minus three and a half.`,
  },
  {
    id: "sdk",
    chapter: "Sixteen defects, each with a hash",
    pad: 0.6,
    shot: { type: "deck", slide: 8 },
    vo: `Sixteen reproducible defects in DreamDEX and its SDK, each one with a transaction
         hash. A pool freezes its whole order book the moment a window expires — including
         the calls the SDK documents as the way to get your escrow out.`,
  },
  {
    id: "close",
    chapter: null,
    pad: 1.5,
    // The landing page, not the dashboard again — the film should not end on a frame it
    // already used, and this one carries the wordmark over the same live figures.
    shot: { type: "page", path: "/", anchor: "#live", needs: "#live" },
    vo: `Abadi is a market maker that survives its own markets expiring, a vault that settles
         itself when nobody is watching, and a measurably tighter book for everyone else
         trading it. Every number you've seen is read from the chain — including the ones
         we'd rather not show you.`,
  },
];

/** The `vo` fields are written as indented template literals; speak them as one line. */
export const spoken = (s) => s.vo.replace(/\s+/g, " ").trim();
