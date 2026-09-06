# Submission — everything DoraHacks asks for, ready to paste

**Abadi is not submitted yet.** Checked again 2026-09-06: **thirty-one BUIDLs are in**, and
none of them is this one. **The deadline is 2026-09-09 01:00 UTC — two days.**

**The field tripled between the 2nd and the 6th, from 13 to 31, and the late arrivals landed
on Abadi's own ground.** HOUSE rests both sides from a wallet on the same no-inventory
mechanism, almost word for word. DreamVault is the depositor half. TEMPO, HedgePulse and
Perennis all put capital into the book. Anything below that counts or ranks the field has to
be re-checked against the live list before it is pasted — see the note under **Vision**.

Submitting needs the DoraHacks account, so it is the one step nobody else can do. This file
exists so it takes ten minutes rather than an evening.

Submit at: **https://dorahacks.io/hackathon/event-contracts/buidl** → *Submit BUIDL*.

The hackathon requires a repo link **and a demo video**. The video is built:
`video/out/abadi-demo.mp4`, 2:48, with `video/assets/abadi-demo.srt` alongside it. It
rebuilds from one script with `npm run video` — see `docs/DEMO-SCRIPT.md`. **The one step
left is uploading it and pressing submit.**

---

## Fields

**Name**

```
Abadi
```

**Vision** — the one paragraph that appears on the card. Keep it under ~350 characters;
every other submission's runs 200–300.

```
An ERC-4626 vault that makes markets on DreamDEX holding no inventory: two opposite buys
cross, the pool mints the pair, and a complete set is worth exactly 1 whichever way the
window resolves. Rebuilt from the venue's own order rows across 70 windows, the book is
23% tighter with Abadi in it. The ledger publishes the losses too.
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

**Demo video**

```
(upload video/out/abadi-demo.mp4 — 2:48, 1080p — and paste the link here)
```

Subtitles: upload `video/assets/abadi-demo.srt` as the caption track. The film also burns
them in, so it reads without them.

**Track**

```
Open Track
```

**Logo / cover image** — `web/logo.svg` is the mark. If a raster is needed,
`web/og.png` is 1200×630 and already carries the wordmark.

---

## The three links a judge should click, in this order

1. **`https://abadi-wheat.vercel.app/dashboard`** — the live book with Abadi's own quote
   tagged inside it, the equity curve that is allowed to go down, and every episode the
   vault has ever run, decoded from the explorer in the reader's browser.
2. **`https://shannon-explorer.somnia.network/address/0xFd9c93581ADD42B9B13ba5550542Fc7315775cD9`**
   — the live vault, verified source. `node scripts/attest.ts` says MATCH.
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
> still. Depositors are down 2.03% while that plays out, and the ledger says so on the
> front page.
>
> 115 unit tests, five stateful invariants, nine fork tests against the real venue, 77
> browser tests, 97.25% line coverage and 43/43 functions on the vault. Sixteen reproducible
> SDK and venue defects reported with transaction hashes.

---

## Before you submit, re-run these

```bash
node scripts/attest.ts     # must say MATCH
node scripts/ledger.ts     # re-read per share and the episode count
node scripts/impact.ts     # re-read the spread with/without
forge test                 # the number the README claims
```

The README, `web/deck.html` and `PRODUCT.md` all state test counts, and CI fails if any of
them disagrees with `forge test`. If you add tests before submitting, update all three.
