# Five days of closing the leg instead of carrying it

**2026-09-06. Vault `0xFd9c93581ADD42B9B13ba5550542Fc7315775cD9`, unchanged since 31 August.**

This replaces the two-day reading in `two-days-of-completing-2026-09-02.md`. Nothing about
the feature changed; there is simply more of it, and the gap it opens got wider rather than
narrower. Four more days also cost the depositors real money, and that is in here too.

## The measurement the feature exists for

Every one-sided fill this project has ever taken, split by what was done about it:

| | episodes | mean result | worst | ended up |
|---|---|---|---|---|
| **carried to settlement** | 26 | **−30.12%** of basis | −100.00% | 2 of 26 |
| **completed** | 14 | **−0.98%** of basis | −3.47% | 4 of 14 |

**Twenty-nine points per adverse episode**, against twenty-two on the 2nd. The tail is the
part that matters and it has not moved: carrying still has a −100.00% in it, completing
still cannot have one, because a pair is worth exactly 1 whichever way the window resolves.

Two of the fourteen completions bought the missing side for less than the pair is worth —
`42a3` landed at 0.987 and `4737` at 0.995 — so getting flat paid rather than cost. That is
not skill, it is the book being briefly crossed, and it is left in the mean rather than
filtered out.

The four days since the 2nd were bad ones for the carried column specifically: `3976` at
−56.45%, `3bc4` at −62.91%, `42a2` at −51.95%. Those are the windows where a leg filled and
the market left, which is exactly the shape `completeSet` exists to stop, and it refused
each of them because the pair cost more than the flip was worth.

## The refusals are the other half

**126 refusals against 14 completions.** `COMPLETE_MAX_LOSS = 0.06` draws the line at 1.060:

| | pair cost |
|---|---|
| cheapest refused | 1.061 |
| median refused | 1.209 |
| 90th percentile | 1.459 |
| dearest refused | 1.562 |

Twenty-seven of the 126 were close calls under 1.10; the rest were not close at all. A pair
at 1.562 books a certain 56% loss to avoid a coin flip, which is worse than the coin flip.
Nine refusals for every completion means carrying is still usually right, and the log says
which times it was not.

## Where the numbers stand

- per share **0.979700**, depositors **−194.20 (−2.03%)** on 9,566.37 of shares
- realised across all thirteen vaults: **−380.00 on 18,761.45 (−2.03%)**
- **193 episodes** — 149 complete sets, 40 one-sided, 2 no-fill, 2 open
- **21% of filled quotes adverse**, against the ~9% the spread needs

Completing lowers what an adverse fill costs. It does not lower how often one happens, and
nothing here claims otherwise — the adverse rate went 19% → 21% over the same five days
that the completed column stayed near flat. The strategy is still losing money at this
adverse rate, and the share price is the number that says so.

## Reproducing this

```bash
node scripts/ledger.ts          # writes docs/evidence/ledger-<date>.md
grep -c "carrying the leg instead" docs/evidence/keeper-local.log   # refusals
grep "pair lands at" docs/evidence/keeper-local.log                 # completions
```

The split above is computed from the ledger's own episode table: a one-sided episode on the
live vault that shows merged collateral was completed, one that reached `settle` with none
was carried. Only the live vault can produce a completion — `completeSet` did not exist
before it — so a "flatten" on an older vault is not one, and counting it as one is how a
+6% mean appears out of nowhere.
