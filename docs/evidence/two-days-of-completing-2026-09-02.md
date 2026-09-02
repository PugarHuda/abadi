# Two days of closing the leg instead of carrying it

**2026-09-02. Vault `0xFd9c93581ADD42B9B13ba5550542Fc7315775cD9`, unchanged since the
31st. 1,262 keeper cycles.**

`completeSet` shipped on 31 August with one live datapoint, and that datapoint was a
*refusal*. Two days later there is a record: **six completions, thirty-four refusals, and
zero trims.**

## The measurement the feature exists for

Every one-sided fill this project has ever taken, split by what was done about it:

| | episodes | mean result | worst |
|---|---|---|---|
| **carried to settlement** | 18 | **−25.98%** of basis · −20.89 tUSDC | −100.00% |
| **completed** | 6 | **−3.98%** of the 100 contracts | −6.00% |

The six, as the bot logged them:

```
f1df  buying UP   100 at 0.562 — pair lands at 1.042, naked leg was risking 0.480
fc09  buying UP   100 at 0.938 — pair lands at 1.012, naked leg was risking 0.074
fee8  buying DOWN 100 at 0.060 — pair lands at 1.059, naked leg was risking 0.119
01b5  buying DOWN 100 at 0.358 — pair lands at 1.060, naked leg was risking 0.418
047f  buying DOWN 100 at 0.154 — pair lands at 1.037, naked leg was risking 0.191
0a17  buying DOWN 100 at 0.260 — pair lands at 1.029, naked leg was risking 0.289
```

Each books a certain loss of between 1.2 and 6.0 on a hundred contracts, and each replaces
a position that resolves to 100 or to nothing. The carried column is what that gamble has
actually paid: sixteen losses, two wins, a mean of −25.98% and a −100.00% in it.

**Twenty-two points per adverse episode**, and it is the tail that matters more than the
mean — completing has no −100 in it and cannot have one, because a pair is worth exactly
one whichever way the window resolves.

## The refusals are the other half

Thirty-four times the guard said no, and the prices it refused were not close calls:

```
1.239  1.416  1.421  1.490  1.524  1.534  1.544  1.562 …
```

`COMPLETE_MAX_LOSS = 0.06` draws the line at 1.060. A pair at 1.562 would book a certain
56% loss to avoid a coin flip, which is worse than the coin flip. The rule fired 34 times
against 6, so most of the time the answer is still to carry the leg — the feature is a
sometimes-move, and the log says which times.

## `reduceQuote` has not fired once, and that is a finding

It is wired, tested, and proven on the real pool. In 1,262 cycles it has never triggered,
and the reason is in the same logs:

```
mid moved 29 ticks in 20s
mid moved 33 ticks in 20s
mid moved 34 ticks in 20s
mid moved 49 ticks in 20s
```

The trim band is `TRIM_TICKS=3` to `DEAD_TICKS=6`. On this venue, at this cadence, a book
that moves thirty ticks between two samples twenty seconds apart is essentially never
observed *inside* a three-tick window. A quote here is either still where the market is or
it is completely stale; there is no drifting middle for a trim to catch.

That is a fact about the venue, not a bug in the feature, and the knob is not being widened
to force a firing — widening it would mean trimming a quote that should be pulled and
requoted where the market actually is. `reduceOrder`'s queue-priority argument needs a
loop that resamples in seconds, which is a different bot from the one running.

## The ledger was wrong, in the flattering direction, and its own check caught it

This is the part worth reading.

After the completions started landing, `scripts/ledger.ts` reported **+335.00 realised**
where it had reported −196.40 two days earlier. A 531-point swing in two days on a vault
whose share price had barely moved.

The ledger prices an episode as *cash back minus what it cost*, and it built "what it
cost" from the `Quoted` event alone. `completeSet` spends collateral that no `Quoted`
event knows about, so a completed episode looked like a pair worth 100 bought for the 48
the original quote escrowed. Six of them inflated the number by **538.20**.

Nothing external caught this. The ledger's own reconciliation did — the check written into
it after the audit in August, which prints realised against what the share price says and
refuses to let them drift:

```
realised on 0xFd9c9358…5cD9 alone:                +525.30 tUSDC
what the share price says depositors are down:     −12.90 tUSDC
difference:                                       +538.20 tUSDC, across 1 open episode
```

A difference that size with one position open is not slack in the account, it is a wrong
number. Both ledgers now read `SetCompleted` and add the spend to the episode's basis:

```
realised on 0xFd9c9358…5cD9 alone:                 +31.20 tUSDC
what the share price says depositors are down:     −12.90 tUSDC
difference:                                        +44.10 tUSDC, across 1 open episode
```

44.10 across one open one-sided fill is the shape the check describes: a naked leg marks
at zero until settlement, so it reaches the share price before it reaches the realised
column.

**This is the second time a new feature has silently flattered this project's own P&L**,
and the second time the share price was the thing that could not be fooled. The lesson is
not "be careful" — it is that every write path which moves collateral needs an event the
ledger reads, and the reconciliation has to stay in the output where somebody sees it.

## Where the numbers stand

- per share **0.998652**, depositors **−12.90 (−0.13%)** on 9,566.37 of shares
- realised across all thirteen vaults: **−159.10 on 12,807.85 (−1.24%)**, from −196.40 on
  9,332.45 (−2.10%) two days ago
- 136 episodes, 106 complete sets, 25 one-sided, 2 no-fill, 3 open
- **19% of filled quotes adverse**, against the ~9% the spread needs. Completing lowers
  what an adverse fill costs; it does not lower how often one happens, and nothing here
  claims otherwise.
