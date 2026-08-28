# Demo video — shot list and script

Target **2:45**. The submission allows 2–3 minutes; leaving 15 seconds of headroom means
you never have to rush the ending, which is where the judges' last impression forms.

**Record on the 27th, not on deadline day.** Testnet has been intermittent — the indexer
returned `fetch failed` roughly one call in five during development. If a take fails, that
is a retry, not a crisis, provided you are not recording the night before.

## What to have open before you start

1. The dashboard artifact, full screen, scrolled to top
2. A terminal in the repo, cleared, ready for `forge test`
3. `docs/evidence/first-fill-2026-08-26.md` in an editor
4. The Shannon explorer on the vault address, one tab over
5. `docs/evidence/first-settle-2026-08-27.md` in a second editor tab — the settle beat
   reads off it

Turn off notifications. Record at 1080p minimum. Speak slower than feels natural — the
whole script is about 380 words, which is a comfortable pace for 2:45 with pauses.

---

## 0:00 — 0:20 · The problem

**Screen:** dashboard, top of page. The wordmark and the thesis line.

> Prediction markets on DreamDEX expire every window. Sixty seconds, fifteen minutes, a
> day — twelve series running at once, and every one of them dies and respawns.
>
> The markets expire. What we built is the liquidity that doesn't.

*Pause on the thesis line for a beat before scrolling.*

---

## 0:20 — 0:55 · Why quoting, not predicting

**Screen:** scroll to the calibration band. Let the six tier bars sit on screen.

> We didn't pick a strategy and then justify it. We pulled every settled market off the
> indexer — two thousand four hundred and twenty-two of them — and asked one question:
> does up win more often than the market prices it to?
>
> It doesn't. Pooled across every tier, up won 49.96 percent of the time. Four hundredths
> of a standard error from a coin flip.

**Screen:** the verdict paragraph under the bars.

> Meanwhile the venue quotes a flat three percent spread on every market. With a coin
> flip and a three percent spread, crossing it costs you one and a half percent a
> contract. Collecting it earns you the same.
>
> So we stopped trying to predict, and started quoting. That decision came from the
> measurement — our first design did the opposite, and the data killed it.

*This is the credibility beat. Do not rush it — a judge who believes this paragraph
believes the rest of the video.*

---

## 0:55 — 1:35 · The mechanism

**Screen:** scroll to the rail, then the ladder.

> DreamDEX keeps one order book, and it has a fill path most venues don't. Two
> opposite-side buyers can cross with no seller at all — the pool mints a fresh up-down
> pair from their combined collateral.
>
> That means you can quote both sides holding nothing.

**Screen:** the ladder, with the two ABADI rows visible.

> Buy up at seventy-four point four. Buy down at seventy-seven. Together that costs
> ninety-seven point four for a hundred contracts a side — not a hundred. The difference
> is the spread, and it's ours the moment both legs fill.
>
> This is the live book, read back after we quoted. Our bid is the best bid on the
> market.

**Screen:** the verdict box under the ladder.

> And the spread on this market went from three cents to two and a half. The incumbent
> quoter tightened in response to us. That's the ecosystem impact — not a claim, a
> screenshot.

---

## 1:35 — 2:15 · The fill

**Screen:** scroll to the position ledger. Then the big zero.

> Then both legs filled.
>
> The vault paid ninety-seven point four. It now holds a hundred up contracts and a
> hundred down contracts — a complete set. At settlement that redeems for exactly a
> hundred, whichever side wins. There is no price at which this position loses.

**Screen:** hold on `0.00` — directional exposure.

> Two dollars sixty locked in, and the number that matters underneath it: zero
> directional exposure. We never took a view. The profit isn't a bet that paid — it's
> the spread, collected.

**Screen:** the settle transaction on the explorer.

> And then the window resolved, and we redeemed it. A hundred back against a basis of
> ninety-seven point six. Net asset value did not move by a single unit across
> settlement — which is the assertion that matters, because a complete set was already
> marked at exactly what it redeems for. If that number had jumped either way, one of the
> two states was mispriced, and share price is where a mispricing gets paid for by
> whoever happens to be holding.

*Twelve seconds. Do not read the transaction hash aloud — point at it and move on.*

**Screen:** the explorer, the `onEvent` transaction whose sender is the vault itself.

> And this one nobody sent. The window expired, the chain woke the vault at the second
> we asked for, and the vault redeemed its own position. The transaction is from the
> vault, to the vault. That is what "the liquidity doesn't expire" means mechanically.

*Eight seconds. This is the single most unusual thing on screen; let it sit.*

**Screen:** cut to the terminal, run `forge test`.

> Sixty-seven tests, including the fuzzed invariant that the vault can never spend more
> than the premium it budgeted.

*Let the test output finish on screen. Green passing tests are worth three seconds of
silence.*

---

## 2:15 — 2:45 · What we'd tell the DreamDEX team

**Screen:** `docs/SDK-FEEDBACK.md`, scrolled slowly.

> Twelve findings, and every one of them only showed up when we ran something rather than
> read about it. Prices are scaled to the collateral's decimals, not to 1e18 — and when
> you get it wrong, the error says your order would cross the book, which sends you
> looking in completely the wrong place. That one cost us hours.
>
> The two that cost us the most came from settling a real position: redemption pulls
> through the module rather than the pool, and nothing says so until the one call that
> turns tokens back into money. And cancelling an order that already filled reverts,
> which breaks cleanup on exactly the position that needs cleaning up.
>
> All of it is written up and reported back, with reproduction steps.

**Screen:** back to the dashboard top.

> Abadi is one vault, a handful of fills, on testnet. It is not a track record yet — a
> handful of fills proves the mechanism, not the edge. But the whole lifecycle has now
> run against the venue: quote, fill, merge, redeem. The capital is non-custodial, and
> the operator key that steers the quotes can't move a single token.
>
> The markets expire. The liquidity doesn't.

---

## Things to say only if asked, not in the video

Keep these ready for judge questions. Putting them in the video costs time and invites
doubt; having good answers ready when asked builds far more confidence.

- **"Is 2.60 on one fill meaningful?"** No, and we say so on screen. It demonstrates the
  mechanism. Adverse selection — being filled preferentially when you're wrong — is the
  real risk and needs many quotes across many windows to measure.
- **"What if only one leg fills?"** Then the vault holds a naked directional leg until the
  other side fills, it's flattened, or the window settles. It happened to us twice on the
  27th and it is worth being specific about: NAV marks that leg at **zero**, not at what
  it cost, so the loss is recognised the moment it happens rather than passed to whoever
  deposits next. NAV may understate. It may not overstate. That's the direction that takes
  money from someone.
- **"Did anything go wrong?"** Yes, and it is in the README rather than buried. Our live
  address turned out to be an older build than our source — `settle` was not in the
  deployed bytecode at all, which is *why* it had never been exercised. Finding that cost
  us a stranded position. Fixing it and quoting again surfaced three more defects in the
  exits, including one where NAV overstated by 2.21% on a one-sided fill. All four are
  fixed, tested, and written up; `scripts/attest.ts` now checks the live bytecode against
  the build so the first one cannot recur. *Offer this if asked, with the fix in the same
  breath — the finding is only impressive alongside what was done about it.*
- **"Did the reactive roll actually run?"** Yes — once out of gas at 500k, then
  correctly at block 472752861 with a measured limit. Both are in
  `docs/evidence/reactivity-live-2026-08-27.md`. Say the failure first; it makes the
  success credible.
- **"What stops the operator running off with the money?"** Nothing in the vault gives it
  a path. It can quote and cancel. `test_operatorCannotMoveAnyFunds` checks all three
  exit routes.

## What not to do

- Don't narrate the architecture diagram. Judges read the repo for that; the video is for
  the parts a diagram can't carry.
- Don't show the contract source. Nobody has ever been convinced by scrolling Solidity in
  a demo video.
- Don't apologise for what isn't finished. State the status plainly once, at the end, and
  move on. The honest one-line version reads as confidence; a paragraph of hedging reads
  as doubt.
