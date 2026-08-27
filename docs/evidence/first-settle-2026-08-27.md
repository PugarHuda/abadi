# settle() and flatten() on chain — 2026-08-27

The two paths built, tested, argued about in the README, and never once run against the
venue. Both ran, twenty minutes apart.

```
vault    0x0f8fB8447e0C550458B5F4Fd41CBbBf2AcAE2387
market   BTC-0-27AUG26-0415/tUSDC   0x…ab3d   900s tier
tx       0x60f880ac7c64ecd70da253a2d410476ad78052c066bfc8c8e620196dbed2a044
block    472312183      gas 516682      status 1
```

## The window, from quote to redemption

Quoted inside the incumbent, both sides, 100 contracts each:

```
theirs  0.637 / 0.665    spread 0.028
ours    0.578 / 0.602    spread 0.024      basis 97.60 for the pair
```

The BUY_NO leg was taken within seconds — BTC ran from 0.59 to 0.68 and left the bid
stranded nine cents under the market. NAV moved immediately:

```
after the quote            4707.60      both legs resting, all of it still cash
after the one-sided fill   4667.80      -39.80
```

That drop is the marking fix working in the open. 39.80 of escrow had become 100
directional DOWN tokens; the old code carried them at what they cost and reported 4707.60
regardless. Anyone depositing in that minute would have bought in against collateral that
was no longer there.

Then BTC came back through the resting bid, the BUY_YES leg filled too, and the slot
completed:

```
holds   100 UP + 100 DOWN     basis 97.60     worth exactly 100 whichever side wins
NAV     4710.00
```

The window resolved UP:

```
payoutNumerators  [10000000, 0]
```

## The call

```
before   NAV 4710.00    idle 4610.00    resting 0.00    slot 0 active
settle(0)
after    NAV 4710.00    idle 4710.00    resting 0.00    slot 0 free
```

`+100.00` redeemed against a `97.60` basis: **2.40 captured, 2.46% of the pair, with zero
directional exposure at any point after the second leg filled.**

NAV did not move across settlement, and that is the assertion that matters. A complete set
was already marked at exactly what it redeems for, so redemption changed the *form* of the
assets and not their worth. A jump in either direction would have meant one of the two
states was mispriced, and share price is where a mispricing gets paid for by whoever is
holding at the time.

## What this closes

The README carried `settle()` under "built and tested, not yet exercised on chain" for a
day. In that time the reason it had never been exercised turned out to be that it had
never been *deployed* — see
[`stale-deployment-2026-08-27.md`](stale-deployment-2026-08-27.md) — and exercising it
then turned up three more defects in the exits around it, see
[`one-sided-fill-2026-08-27.md`](one-sided-fill-2026-08-27.md).

Redemption after resolution is now a thing this vault has done, not a thing it is designed
to do.

## flatten(), on the next window

The final vault quoted `ETH-0-27AUG26-0430` at `0.639 / 0.663` inside a `0.637 / 0.665`
book, and both legs filled inside a minute. ETH kept going: the book walked to
`0.711 / 0.738` and left the quote seven cents behind, dead for the rest of the window.

A complete set is worth exactly 1 per pair at any moment, so there is no reason to leave
it sitting until the window resolves. That is what `flatten` is for, and this is the shape
it was written for — a dead quote, eleven minutes still on the clock, and capital that
could be quoting somewhere else.

```
tx       0xf2f625213296406a2bfb3ed99a65290917097948259069f2662db73a39027b3c
block    472314040      gas 807868      status 1

before   NAV 4712.40    idle 4612.40    slot 0 holds 100 UP + 100 DOWN
flatten(0)
after    NAV 4712.40    idle 4712.40    slot 0 free, 671s before expiry
```

`mergeCompleteSet` returned the full `100.00` against the `97.60` basis — the same 2.40,
taken 11 minutes early and without waiting on an oracle. NAV again did not move, for the
same reason it did not move across `settle`: the set was already marked at what it is
worth.

`quote`, `flatten`, and `settle` have all now been run against the live venue.
`cancelQuote` has not. Its interesting case is the one where a leg has already filled and
the stored id is dead — the shape that reverted `IncorrectSender` on the old build — and
that cannot be summoned on demand. It arrives when the market takes one side and leaves
the other. Two of the four windows quoted today produced it; neither did so on a vault
that could yet survive it.
