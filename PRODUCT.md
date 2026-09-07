# Product

<!-- impeccable:product-schema 1 -->

<!-- Written from the repository and the standing brief ("gas kerjakan"); no interview
     round was answered. Every fact below is inferred from code, evidence files, and
     conversation, and marked [inferred] where the repository alone does not prove it. -->

## Platform

web

## Users

- Hackathon judges for the Somnia × DreamDEX Event Contracts Hackathon, reading a
  submission among many, on a laptop, in a few minutes, deciding whether the mechanism is
  real and whether the team knows what it built. [inferred: primary audience]
- DreamDEX / Somnia engineers reading `docs/SDK-FEEDBACK.md` and the evidence, verifying
  claims against the explorer.
- Later: depositors evaluating an ERC-4626 vault — people who read NAV, share price, and
  a track record before they read prose. [inferred]

## Product Purpose

Abadi is a market-making vault for DreamDEX Event Contract markets on Somnia. It rests a
two-sided quote inside the incumbent spread on short-lived binary windows, holds one of
each side when both legs fill, and collects the spread with zero directional exposure. It
exists because the venue's 2.9% flat spread is the only edge the data supports:
2,422 settled markets resolved as a coin flip. Success is a growing, on-chain track record
of complete sets closed at ~2.5% each, with no capital stranded and no keeper trusted.

## Positioning

Zero-inventory two-sided quoting through the venue's mint-a-pair path — a Buy UP crossing
a Buy DOWN needs no seller, the pool mints the pair — and a vault that **wakes itself** at
window expiry through Somnia's reactivity precompile to redeem its own position. Both are
demonstrated with block numbers, not claimed. The honest ledger of what went wrong, what it
cost, and what was fixed is part of the positioning, not an apology for it.

## Operating Context

- Somnia Shannon testnet (chain 50312). Windows on 60s to 24h tiers, BTC and ETH.
- The live vault address lives only in `.vault-addr`; the site reads the vault in the
  visitor's browser via public RPC, and the track record via the explorer's log API.
- A keeper runs from GitHub every fifteen minutes; the vault arms its own wake-ups when it
  holds 32 STT.
- Evidence is in `docs/evidence/*.md`, one file per thing that happened.

## Capabilities and Constraints

- Contracts: `LiquidityVault` (ERC-4626, quote/cancel/flatten/settle, per-slot sweep,
  `sweepNative`, `LastShareWhileOpen`, `MarketAlreadyQuoted`), `AbadiReactive`,
  `MarketEngine`. 149 unit tests, five stateful invariants, nine fork tests against the
  real venue. `attest.ts` reports MATCH against the live address and that address is verified
  on the explorer; coverage is
  97.28% of lines and 100% of the vault's 43 functions.
- Scripts: `bot.ts` (requote loop), `ledger.ts` (episodes from chain events),
  `attest.ts` (live bytecode vs. artifact), `fork-test.ts`, `operator.ts`, `verify.ts`.
- Site: four pages plus 404, **Next.js App Router, statically exported** to `out/`, hosted
  on Vercel at https://abadi-wheat.vercel.app. Nothing renders per request — every number a
  reader sees is read from the chain in their own browser, which is the rule below and
  predates the framework, so a server runtime would only add somewhere for it to be broken.
  Routing, the document shell, `metadata`, `robots.txt` and `sitemap.xml` are the
  framework's; the live strip, the ledger and the wallet calls stay plain JS against public
  APIs, loaded per page. The migration was verified by rendering the pre-framework build from
  the same sources and comparing every page's body against the export — all five matched, twice
  in CI — and that reference build was retired when the header became a shared component, which
  is the first change the two versions were ever meant to differ on.
- What the framework cost, stated rather than absorbed: a page shipped **37 KB** before it and
  ships about **505 KB** after. The weight budget in `qa/perf.spec.ts` is two numbers now — the
  document, the stylesheets and our own modules stay under the **100 KB** they were always
  held to (25–91 KB by page), and React with the App Router runtime is a separate **447 KB**,
  identical on every page and capped so it cannot drift. Merging them would have meant one
  600 KB number with the old standard lost inside it. LCP is still inside Google's 2.5s.
- Film: `video/`, one script (`video/script.mjs`) that owns both the voice-over and the shot it
  plays over, rebuilt end to end with `npm run video`. edge-tts speaks each line and returns a
  word boundary per word, so the subtitles land on the word with no alignment step; Playwright
  drives the live site and the explorer and draws its own pointer, so a demo of software
  somebody operates shows it being operated; Remotion lays voice, footage and captions on one
  timeline. Every number the voice states is checked against the chain before a render —
  `docs/DEMO-SCRIPT.md` is that checklist and the record of what each re-record changed.
- Constraint: nothing on the site may be a mock, placeholder, or "coming soon". A number
  is live from chain or it is not shown; a failure state says so.
- Terminology: UP/DOWN (the venue's), "complete set", "naked leg", "one-sided fill",
  "flatten" (merge early), "settle" (redeem after resolution), "sweep" (the wake-up).

## Brand Commitments

- Name: Abadi — Indonesian for *everlasting*. Line: "The markets expire every window.
  The liquidity doesn't."
- Mark: one contract split by a price — turmeric and teal blocks, a hairline price level
  drawn past the block. `public/logo.svg`.
- Palette in use: ink `#14203A`, raised `#1B2A48`, line `#2A3B5E`, cotton `#EAE4D6`,
  cotton-dim `#8D97AE`, turmeric `#E0A045` (UP), teal `#4FA396` (DOWN).
- Type in use: Bricolage Grotesque (display), Public Sans (body), Martian Mono (numbers,
  addresses, code).
- Voice: plain, specific, no hype; failures stated before successes; numbers with units.

## Evidence on Hand

- On-chain: ~20 transactions cited in `README.md` and `docs/evidence/`, every one checked
  by a browser test against the explorer.
- `docs/evidence/calibration-2026-08-26.md`: 2,422 settled markets, UP 49.96%.
- `docs/evidence/ledger-*.md`: every episode, generated by `scripts/ledger.ts`.
- `docs/evidence/reactivity-live-2026-08-27.md`, `first-settle-2026-08-27.md`,
  `verification-2026-08-28.md`, `bot-run-*.txt`.
- No testimonials, no customers, no mainnet deployment, no audit. Do not invent any.

## Product Principles

1. A number on screen is read from the chain in the reader's browser, or it is not shown.
2. State the failure before the fix; the fix is only credible next to what it cost.
3. The live address is the source — `attest.ts` and the explorer both say so, or the
   difference is written down where the claim is made. It is written down right now: the
   source is two guards ahead of the deployed vault, and `attest.ts` names them.
4. Nothing waits for a human: settle is permissionless, the sweep is armed, the keeper is
   scheduled.
5. Every claim has a transaction hash a judge can click.

## Accessibility & Inclusion

WCAG 2.1 AA on every page, enforced by axe-core in CI; keyboard-operable slider with
ARIA value text; reduced-motion respected; no horizontal scroll at 375px.
