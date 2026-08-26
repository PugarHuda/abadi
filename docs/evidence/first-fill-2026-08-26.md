# First fill — the thesis, realised

Vault `0xbcc310b25961bFd241646505c4baE18a518c0A77`, Shannon testnet, 2026-08-26.

## What happened

The quote from `live-quote-2026-08-26.md` rested at **0.744 / 0.770** on
`ETH-0-27AUG26/tUSDC`. Over the following hours ETH moved and the market's implied
probability fell from roughly 0.75 to 0.50. Both of our resting legs were taken.

On-chain holdings now:

```
OutcomeToken6909  0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9
  yesId …219584   100.000000
  noId  …219585   100.000000
collateral idle                4,902.600000 tUSDC
```

100 YES **and** 100 NO. A complete set.

## The arithmetic

```
paid at quote time        97.40 tUSDC   (= 100 x (1 - spread))
holds                     100 YES + 100 NO
worth at settlement      100.00 tUSDC   whichever side wins
                        ---------------
locked in                 +2.60 tUSDC
directional exposure        0.00
```

**2.67% on deployed capital, in one window, with no view on the outcome.**

A complete set redeems to exactly 1 per pair regardless of resolution: the winning side
pays 1 and the losing side pays 0, and the vault holds one of each. There is no price at
which this position loses. The 2.60 is the spread, and it was captured by resting inside
the incumbent's quote rather than by predicting anything.

## Why this matters more than the earlier numbers

`calibration-2026-08-26.md` derived +1.45% per fill as an **upper bound** — half the
observed spread, before adverse selection. That was arithmetic on historical outcomes.

This is a filled position. The mechanism is no longer inferred:

- Both legs were **buys** (`BUY_YES` and `BUY_NO`). Neither could have filled against a
  seller, because no seller was involved.
- They filled through the venue's **mint-a-pair** path: two opposite-side buyers cross
  with no seller at all, and the pool mints a fresh YES/NO pair from their combined
  collateral.
- That is why the position cost 97.40 rather than 100, and why it required **no
  inventory** to begin with.

Zero-inventory two-sided quoting is not a design claim any more. It happened.

## Honest notes

**This is one fill, not a track record.** A single observation says the mechanism works;
it says nothing yet about fill frequency or about adverse selection over many quotes.
Adverse selection is precisely the risk a maker carries — you are filled preferentially
when you are wrong — and one profitable pair does not measure it. Measuring it needs many
quotes over many windows.

**Both legs filling is the good case.** Had only one leg filled, the vault would hold a
naked directional position rather than a complete set, and would be exposed until the
other side filled or the position was flattened. That case is real and is what the
`minHalfSpread` floor and the expiry headroom exist to manage.

**The capital is no longer idle until settlement.** `flatten()` now merges held complete
sets back to collateral immediately via `mergeCompleteSet`, so the capital can quote
again without waiting for the window to resolve.

Access to it is split rather than open, and the reason is worth stating. `settle()` can
be permissionless because a settled market cannot trade — there is nothing left to
destroy. `flatten()` is not the same: cancelling a live quote throws away the spread the
vault exists to earn, so an open version would let anyone grief the vault by closing good
quotes on repeat. The operator may flatten whenever it judges a quote dead; **anyone** may
flatten once the market can no longer trade, because past that point no fill is possible
and capital must not sit behind a key that has gone quiet.

An uneven fill leaves a single-side leg that cannot be merged and still carries
direction. `flatten` merges what it can and leaves the slot open so `settle()` can redeem
the remainder.
