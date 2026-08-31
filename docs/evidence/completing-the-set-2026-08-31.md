# The move the strategy never had, and what the book looks like with us in it

**2026-08-31, Shannon (50312). Vault `0xFd9c93581ADD42B9B13ba5550542Fc7315775cD9`,
replacing `0x2c96022771e8368283F8909C9a1923a4De9781E7`.**

Four things landed together because three of them needed the same redeploy. They are in
order of how much they change: the first one is where the money is, the last one is a
number that should have existed all along.

## 1. The whole loss was in one tier, and it was already fixed

Before building anything, the ledger was asked where the −196.40 actually came from.

| tier | episodes | adverse | realised | on basis |
|---|---|---|---|---|
| 15m | 6 | 0% | +14.80 | 585.20 |
| **1h** | **40** | **32%** | **−187.40** | 3,176.65 |
| 24h | 10 | 33% | −18.20 | 879.00 |
| 4h | 49 | 6% | −5.60 | 4,691.60 |

**95% of every loss this project has taken is in the 1h tier**, and the bot stopped
quoting 1h and 24h days ago — `TIERS=14400,900`, printed in every cycle's log. On the
tiers it still quotes the record is **+9.20 on 5,276.80 across 55 episodes, 6% adverse**,
under the ~9% the spread needs.

That is not published as evidence of an edge and it should not be read as one: the two
tiers were dropped *using this same data*, so the split is in-sample by construction. It
is here because "the strategy is losing" was the honest headline for a configuration that
has not run since the 29th, and repeating it would be its own kind of inaccuracy.

## 2. `completeSet` — buy the missing side instead of carrying it

Eighteen episodes in the ledger are one-sided: one leg filled, the book walked away from
the other, and the vault was left holding a direction it never wanted. They cost between
6.83 and 76.00 on a basis under 100. The only move the vault had was to cancel the
unfilled leg and wait for settlement, where the naked side is worth 1 or 0.

A maker does not wait. It pays the spread to get flat. Two opposite-side buys mint a pair
on this venue, so a BUY_NO priced at or under the best resting bid crosses it, and the
naked leg becomes half of something worth exactly 1.

The unit test measures the difference on the same staged fill:

```
carried to settlement (what the vault could do before)   451.50 of 500.00 remains
completed with completeSet                               498.50 of 500.00 remains
```

`test_completeSetTurnsANakedLegIntoAPair` and
`test_theNakedLegLosesTheWholeLegWhenItIsNotCompleted` are the same 100-contract YES fill,
and they differ by **47.00**.

**IOC, not a limit order.** What does not cross now must not become a second resting order
the vault has to manage. A partial fill is a partial success and the call can be made
again as depth arrives, which `test_completeSetTakesWhatCrossesAndRestsNothing` pins at
40 then 60 of a 100 shortfall.

**`maxSpend` is the operator's judgement, priced on chain.** No contract can know the
right price, but the caller can state a price the vault must never exceed, and above it
the whole call reverts with nothing moved.

### It refused, live, on its first chance

At 15:17Z the vault quoted BTC-0-31AUG26-1530 at 0.537 / 0.563 for 50 contracts. The UP
leg filled alone; NAV fell 26.85 because a naked leg marks at zero. The next cycle found
it and **declined to complete it**:

```
15:19:36 skip  slot 1 f114  completing costs 0.702 on top of 0.537 = 1.239 the pair,
               over the 1.060 line — carrying the leg instead
```

The book had moved far enough that closing the position would have cost 0.179 above par.
Carrying the leg is the better of two bad options there, and the guard said so with its
arithmetic. This is the live evidence available today, and it is a refusal rather than a
success — paying 0.179 over par with depositor capital to produce a nicer screenshot is
exactly what this project refuses to do.

That the *successful* path works is pinned against the real venue rather than the mock:
`test_fork_completeSetClosesANakedLegOnTheRealPool` stages a genuine one-sided fill on a
live window, crosses a resting BUY_YES with an IOC BUY_NO, and asserts the real module
then merges the pair for exactly its size.

## 3. `reduceQuote` — trim in place, keep the queue

`reduceOrder` has shipped in the SDK the whole time and no operator key could reach it,
because every order id this vault owns lives behind its own custody. Cancel-and-replace
surrenders price-time priority; a reduce does not, and being early is most of what a
maker's queue position is worth.

The venue's own `getOrder` documentation warns that an id can be **"replaced by a
reduce"**. If that were true the vault would silently lose the handle to its own order —
escrow would read as zero and the cancel path would have nothing to cancel. So the
contract does not trust the call: it reads the leg back, and unless the same id is still
resting at the new size the whole transaction reverts and the operator falls back to
cancel-and-requote.

**On the real pool the id survives.** `test_fork_reduceQuoteKeepsTheOrderIdOnTheRealPool`
reduces a live 100-contract quote to 50, asserts both order ids are unchanged, asserts the
pool released the escrow it no longer needs, and then has a taker fill the trimmed leg for
exactly what was left. That answers a question the SDK's own docs leave open.

`test_reduceQuoteRevertsIfThePoolMovesTheOrder` holds the other half: a pool that *does*
replace the id is refused, and the slot is left untouched.

## 4. The settle sandwich, closed properly this time

A naked leg marks at zero, so a *winning* naked leg on an already-resolved market is real,
certain, public value that NAV does not show — and `settle` is permissionless. Deposit,
settle, redeem was a riskless profit funded by the holders already there.

It was closed in August with a **one-block** guard, on the reasoning that atomicity was
what made it riskless. That reasoning was half right, and the code said so itself:

> It does not close the patient version — deposit, wait, settle, redeem — which is bounded
> by the risk of holding rather than by this guard.

Somnia's blocks are sub-second. One block is not a holding period; it is a formality a bot
clears without noticing. What the attacker must be made to do is **carry the mark**, and
that takes time, not a block.

`redeemDelay` is 300 seconds — the venue's own settlement window — set at construction,
tunable by governance, and capped at one hour by `MAX_REDEEM_DELAY` because a governor who
could set it without bound could freeze every withdrawal in the vault, which is precisely
the custody power this contract exists not to have.
`test_aDepositCannotBeUnwoundInsideTheRedeemDelay` now asserts the *old* guard's hole
directly: one block later still reverts.

## 5. The book, live, with our own quote in it

The dashboard's order-book ladder was hand-written HTML from a fill on 27 August, sitting
under a heading that said "as read back", on a page whose first principle is that a number
is read from the chain in the reader's browser or it is not shown. The loudest rule this
project has, broken on its own evidence page.

`web/book.js` replaces it with two public reads and nothing of ours in between: an
`eth_call` to the RPC for which window the vault is quoting, and the venue's indexer for
every open order on it. A row is marked ABADI when the order's **owner is the vault
address** — the same field the venue uses to decide whose order it is. Between quotes it
says so; when a read fails it says which one.

## 6. What the venue's book looks like with Abadi in it

The README has claimed since day one that "the incumbent tightened in response". That was
one episode, which is an anecdote.

The indexer still holds every order that ever rested on every window, open, cancelled or
filled, with the timestamp it was placed and the timestamp it stopped. So the book can be
rebuilt at any instant, twice: once with Abadi's orders and once with them removed. The
difference is this project's contribution to that market, in ticks, measured from the
venue's own rows.

`node scripts/impact.ts`, over every window Abadi has ever quoted:

| | windows | mean spread | in ticks |
|---|---|---|---|
| the book as it was | 70 | 0.0249 | 24.9 |
| the book with Abadi in it | 70 | 0.0192 | 19.2 |
| **difference** | | **−0.0058** | **−5.8** |

**Abadi tightened the book on 66 of 70 windows, left it unchanged on 4, and widened it on
none.** A 23% narrower spread, on the venue's own record, for everyone else trading those
markets.

Widening is not filtered out — a quote resting outside the incumbent's touch does not move
the touch, and a maker that only ever quoted inside would be one that never quoted when
the spread was already tight. It simply did not happen.

## 7. Coverage, measured for the first time

It had never been run, and the reason turned out to be real: `forge coverage` disables the
optimizer, and `completeSet` as first written went over the EVM's stack limit without it —
a function that only compiles with the optimizer on is a function nobody can measure. The
crossing order moved into its own frame (`_cross`), which fixed it. `quote` still needs
`--ir-minimum`, which is why the command carries that flag.

```
src/AbadiReactive.sol    92.31% lines ·  92.31% statements · 66.67% branches · 100.00% functions (6/6)
src/LiquidityVault.sol   97.25% lines ·  93.87% statements · 74.75% branches · 100.00% functions (43/43)
src/MarketEngine.sol    100.00% lines ·  91.30% statements · 42.86% branches · 100.00% functions (11/11)
```

Every function in all three contracts is exercised. The branch column is the honest gap
and it is quoted unrounded: the uncovered arms are mostly the revert side of guards whose
positive path is already tested, and MarketEngine's 42.86% is seven branches total, a
denominator where one uncovered arm moves the figure fourteen points.
[`coverage-2026-08-31.txt`](coverage-2026-08-31.txt)

## What is still open

- **The completion has not yet closed a real position at a good price.** One live chance,
  one honest refusal. The fork test is the proof the path works; the ledger will be the
  proof it pays.
- **`reduceQuote` is wired but the trim threshold is a guess.** `TRIM_TICKS=3` sits
  between "the book moved" and `DEAD_TICKS=6`. Nothing has measured whether trimming
  beats pulling.
- The strategy's economics still rest on 55 episodes of a configuration that is four days
  old.
