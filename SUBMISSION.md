# Submission — everything DoraHacks asks for, ready to paste

**Abadi is not submitted yet.** Checked again 2026-09-07 11:25 UTC: **forty-nine BUIDLs are
in**, and none of them is this one. The page says one day left.

**The deadline is 2026-09-08 18:00 UTC.** That is `timeline_end` on the hackathon's own
record, and it is 01:00 on the 9th in Jakarta — this file said "2026-09-09 01:00 UTC" until
now, which is the local hour mislabelled as UTC and seven hours of runway that does not
exist.

**The field went 13 → 34 → 49 between the 2nd and the 7th**, and ten of those arrived in the
last twenty hours: Project Transparency Analyzer, Onyxpulse, Kalibra, Keel, Puls3, AEGIR MART,
Proofside, Watchman, DreamDEX Up/Down, WindowGuard. **None of the ten is a market-making
vault** — they are consumer one-tap apps, pre-trade safety checks and scoring tools — so the
thesis is not more crowded than it was yesterday, only the field is.

One of them is worth knowing about before a judge mentions it: **Henessay's DreamDEX Up/Down
"ships with a 21-entry feedback report"**, which is more entries than this project's sixteen.
The answer is not to count higher. Ours are filed on the venue's own tracker as
dreamdex-bot-kit#26–#41 with a pull request behind them, which is a different claim from a
report in a repository, and it is the claim to make. **Ballast** is the closest: a pooled
counterparty quoting both sides of every window, opening on a measurement of its own — "83.5%
of 5,000 DreamDEX markets never saw a single trade" — which is this project's move as well as
its thesis. HOUSE rests both sides from a wallet on the same no-inventory mechanism, almost
word for word. DreamVault is the depositor half. TEMPO, HedgePulse and Perennis all put
capital into the book. Anything below that counts or ranks the field has to be re-checked
against the live list before it is pasted — see the note under **Vision**.

The list is at `https://dorahacks.io/api/v1/hub/hackathons/2358/buidls?page=1&page_size=60`,
which answers 405 to a plain fetcher and needs a **headed** browser; fetch it from inside the
page context once Cloudflare clears.

Submitting needs the DoraHacks account, so it is the one step nobody else can do. This file
exists so it takes ten minutes rather than an evening.

Submit at: **https://dorahacks.io/hackathon/event-contracts/buidl** → *Submit BUIDL*.

The hackathon requires a repo link **and a demo video**. The video is built:
`video/out/abadi-demo.mp4`, 2:56, with `video/assets/abadi-demo.srt` alongside it. It
rebuilds from one script with `npm run video` — see `docs/DEMO-SCRIPT.md`. **The one step
left is uploading it and pressing submit.**

---

## Fields

**Name**

```
Abadi
```

**Vision** — the one paragraph that appears on the card. **The form's hard limit is 256
characters**, not the ~350 this file said until the form refused a 331-character paragraph.
This is 249, which leaves seven for a smart quote:

```
An ERC-4626 vault that market-makes DreamDEX Event Contracts holding no inventory: the pool mints a pair worth exactly 1 either way. Rebuilt from the venue's own order rows over 70 windows, the book is 23% tighter with Abadi in it. Losses published.
```

What went to make it fit, in order of what was least load-bearing: the mechanism sentence
("two opposite buys cross") — "holding no inventory" and "a pair worth exactly 1 either way"
carry it between them — and "the ledger publishes the losses too" shortened to two words.
What did NOT go: **70 windows**. The sample size is what makes 23% a measurement rather than
a boast, and it is the one claim in this field nobody else makes.

If a shorter one is ever needed, this is 244:

```
An ERC-4626 vault that market-makes DreamDEX Event Contracts holding no inventory: the pool mints a pair worth exactly 1 either way. Rebuilt from the venue's own order rows, the book is 23% tighter with Abadi in it. The ledger publishes losses.
```

⚠ **The earlier version of this paragraph opened "Twelve projects here read DreamDEX. Abadi
is the only one that puts capital into it." That was true on 2026-09-02 and is false now** —
HOUSE, DreamVault, TEMPO, HedgePulse and Perennis all put capital in. Lead with the
measured effect on the book, which no other submission claims, and never with a count of
the field.

**GitHub**

```
https://github.com/PugarHuda/abadi
```

**Demo / live app**

```
https://abadi-wheat.vercel.app
```

**Demo video** — REQUIRED, and it is the one thing here that nobody else can do.

```
(upload video/out/abadi-demo.mp4 to YouTube — 2:56, 1080p — and paste the link)
```

YouTube specifically: the form says a YouTube link renders as an embedded player, which is
what a judge will actually press play on. Unlisted is fine.

Subtitles: upload `video/assets/abadi-demo.srt` as the caption track. The film also burns
them in, so it reads without them.

**Track**

```
Open Track
```

**Category** — the form's own tag list. Match what the card should be filed under:

```
Crypto / Web3 · DeFi · Prediction Markets · Somnia
```

**BUIDL logo** — the form wants JPEG or PNG, under 2 MB, 480×480 recommended.

```
public/logo-480.png          480×480, 2 KB — the mark on the site's paper
```

`public/logo.svg` is the same mark as vector and `public/og.png` is the 1200×630 card with
the wordmark; neither is square, which is why the tile exists. Regenerate it with
`node scripts/logo-tile.mjs` if the mark ever changes.

**Social links** — the form requires **at least one**, and this is the field most likely to
stop the submission, because this project has no social account. What it does have:

```
https://github.com/PugarHuda
```

A GitHub profile is a real account with the work on it, which is more than a placeholder. If
you would rather post from an X account, create it first — the field takes up to three.

---

## The three links a judge should click, in this order

1. **`https://abadi-wheat.vercel.app/dashboard`** — the live book with Abadi's own quote
   tagged inside it, the equity curve that is allowed to go down, and every episode the
   vault has ever run, decoded from the explorer in the reader's browser.
2. **`https://shannon-explorer.somnia.network/address/0xFd9c93581ADD42B9B13ba5550542Fc7315775cD9`**
   — the live vault, verified source. `node scripts/attest.ts` says MISMATCH and prints
   why: `src/` is two guards ahead of this deployment, deliberately, two days from the
   deadline. README → "The source is ahead of the chain".
3. **`docs/evidence/`** — one file per thing that happened, including the things that went
   wrong and what they cost.

## What to say if there is a description box beyond the vision field

> Abadi is a market-making vault for DreamDEX Event Contracts on Somnia Shannon.
>
> It rests a two-sided quote inside the incumbent's spread holding no inventory: two
> opposite-side buys cross with no seller, the pool mints the pair, and a complete set
> redeems for exactly 1 whichever way the window resolves. The operator key can choose a
> price and a size and can do nothing else — it cannot move a token, and no function exists
> that would let it.
>
> **What we can prove.** Rebuilding 70 of the windows we have quoted from the venue's own
> order rows, twice — with our orders and without — the spread was 0.0249 without Abadi and
> 0.0192 with it: 23% narrower, tighter on 66 of 70, wider on none. Measured 2026-08-31 and
> published in `docs/evidence/impact-2026-08-31.txt`.
>
> **What we got wrong and fixed in public.** This project once published a +2.37% return.
> The ledger was summing only the episodes that closed into a complete set, so it could not
> produce a loss. We audited ourselves, published the correction, and rebuilt the ledger to
> price every episode — winners and losers — against its full basis. The same reconciliation
> caught a second flattering bug a week later, and that is in the evidence too.
>
> **What the measurement changed.** One leg filling while the market walks away from the
> other is the real risk a maker carries. Twenty-six of those, carried to settlement, cost
> an average of −30% of basis with a −100% in them. The vault now crosses the book to buy
> the missing side, so the pair is worth exactly 1: fourteen of those have cost −1% on
> average, worst −3.5%, and it refused 126 times when getting flat was worse than standing
> still. Depositors are down 3.27% while that plays out, and the ledger says so on the
> front page.
>
> 148 unit tests, five stateful invariants, nine fork tests against the real venue, 96
> browser tests, 97.28% line coverage and 43/43 functions on the vault. It also passes
> **a16z's ERC-4626 property suite** — all 26 fuzzed properties, conformance defined by
> somebody who has never seen this vault rather than by our own coverage number. Sixteen
> reproducible SDK and venue defects, each one filed on the venue's own tracker
> ([dreamdex-bot-kit#26 … #41](https://github.com/somnia-chain/dreamdex-bot-kit/issues?q=is%3Aissue+Abadi)) with transaction hashes, six of them also proposed back
> into the kit's own gotchas doc as [PR #42](https://github.com/somnia-chain/dreamdex-bot-kit/pull/42), and the venue's error table
> uploaded to the public signature databases so its reverts decode for every team on the
> chain, not just for us.

---

## Before you submit, re-run these

```bash
node scripts/attest.ts     # MISMATCH is expected — it must name only MAX_HEADROOM_BPS()
node scripts/ledger.ts     # re-read per share and the episode count
forge test                 # the number the README claims
node scripts/impact.ts     # slow — see below; the published figure stands without it
```

**`impact.ts` is the slow one and it is not a blocker.** It asks the indexer one question
per window it has ever quoted — 131 of them on 2026-09-06 — one after another, and each
takes tens of seconds. A full run is well over half an hour. It prints its progress to
stderr now, because an earlier version printed nothing at all until it finished and there
was no way to tell work from a hang.

The spread claim quoted above is the measurement of **2026-08-31**, dated as such everywhere
it appears, with `docs/evidence/impact-2026-08-31.txt` behind it. Do not hold up the
submission waiting for a fresher one, and do not describe the 70 windows as "every window we
have quoted" — there are 223 episodes now.

The README, `app/deck/page.tsx` and `PRODUCT.md` all state test counts, and CI fails if any of
them disagrees with `forge test`. If you add tests before submitting, update all three.

---

## After you submit: the twenty minutes that are worth more than another test

The rubric gives **20% to Business & Ecosystem Impact** and **15% to Presentation**, and
this project currently has no presence outside its own repository at all: searching for it
by name returns nothing, and no human on the Somnia side has ever seen it. Every other
number here is already earned. This is the part that is not.

**1. The hackathon's own Telegram** — `https://t.me/+XHq0F0JXMyhmMzM0`, linked from the
hackathon page. Paste this:

> Submitted Abadi — an ERC-4626 vault that market-makes DreamDEX Event Contracts holding
> no inventory. Two opposite-side buys cross with no seller, the pool mints the pair, and a
> complete set is worth exactly 1 either way the window resolves.
>
> The part I'd point at: I rebuilt 70 of the windows the vault quoted from the venue's own
> order rows, twice — with our orders and without. Spread 0.0249 without, 0.0192 with.
> Tighter on 66 of 70, wider on none. The book measurably improved because something was
> resting in it.
>
> The ledger publishes the losses too: per share 0.967282, depositors down 3.27%, 21% of
> filled quotes adverse where the spread needs under ~9%. It's on the front page rather
> than in a footnote.
>
> Also filed 16 reproducible SDK and venue defects on dreamdex-bot-kit (https://github.com/somnia-chain/dreamdex-bot-kit/issues?q=is%3Aissue+Abadi) with tx hashes,
> plus a PR adding the six binary-market ones to its gotchas doc (https://github.com/somnia-chain/dreamdex-bot-kit/pull/42),
> and uploaded the venue's error table to the public signature databases — 637 signatures
> newly registered, so its reverts decode in `cast 4byte` for everyone now, not just for us.
>
> https://abadi-wheat.vercel.app · https://github.com/PugarHuda/abadi

**2. The same, shorter, wherever you post publicly.** Lead with the spread measurement. It
is the one claim in this field that no other submission makes.

**3. Do not lead with "the only one".** Thirty-four BUIDLs are in and at least six put
capital into this book. Lead with the measurement, which is still uncontested.
