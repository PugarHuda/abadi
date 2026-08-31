# What a twelve-angle audit found, and what was done about it

**2026-08-31. Vault `0x2314436ed2BDC44321c74EF43adA14CAE723D352` (still the previous build — see the last section).**

Twelve parallel sweeps over the contracts, the bot, the tests, the site, the prose, the
economics, the secrets and the venue. Seven proof-of-concept exploits were written and
passed; seven mutations survived the entire test suite; one earlier finding was withdrawn
on measurement. This is the record of what was true and what changed.

## The one that mattered most, and it was not a bug

`scripts/ledger.ts` accumulated profit and basis **only** inside the complete-set branch.
A one-sided episode incremented a counter and entered neither the numerator nor the
denominator. `web/ledger.js` was the same code, and it is what rendered on the dashboard,
so the published "+133.85 tUSDC on 5,641.15 of basis (2.37%)" described the winners alone
and the equity curve was structurally incapable of drawing a drawdown.

The vault's own share price, read off the chain across the audit:

```
17:30   totalAssets 4478.97   supply 4684.37   share 0.956152   −205.40
18:12                                          share 0.953190
20:1x   totalAssets 4445.42                    share 0.948990   −238.95   (−5.10%)
```

Escrow was `0.00` at the first and last of those, so it is realised, not a mark. Holding
the tUSDC would have beaten the vault. Fixed: losses are in the P&L and the basis, share
price is the headline, and the chart can go down.

## Accounting

**`_restingEscrow` inferred fills from a token balance, and two other things move it.**
It computed unfilled quantity as `size − balanceOf(outcomeId)`. `mergeCompleteSet` burns
that balance, so a leg that had filled in full read back as never filled and its escrow was
counted again on top of the cash the merge had just delivered. Deterministically, through
`flatten` alone — no sweep, no fork, no fuzzing luck:

```
real cash held           503.000000
totalEscrowed says        97.000000
the pool actually holds    0.000000
totalAssets says         600.000000
alice can redeem         599.999999
```

That is the project's own `invariant_restingEscrowMatchesThePoolsOwnLedger` failing.
ERC-6909 transfers are also permissionless, so a stranger could donate outcome tokens and
move the share price without touching the vault.

Fixed by not inferring. `_restingEscrow` now asks the pool — `getOrder(orderId)` returns
`quantityRemaining`, and reverts for an id with no active order, which is the answer
"nothing is resting here". Confirmed against the real pool: `getOrder` answers normally on
a frozen book while every cancel path reverts, so the freeze gates writes, not reads.
`test_flattenInTheFrozenGapDoesNotInventEscrow` is the regression.

**A tied or split payout vector abandoned half the position.** `_settle` took the argmax of
`payoutNumerators()` and redeemed that side alone. Settlement v3 stores a vector, not a
winner: on `[7, 3]` the 30% side was abandoned, and on a tie `[5, 5]` with `isVoided()`
false the argmax picked index 0 and abandoned the other side entirely — with the slot
already deleted, so nothing could come back for it. Now every side with a non-zero payout
is redeemed, exactly as the voided branch already did.

**One wei defeated the last-share guard.** It gated on `shares == totalSupply()`, so any
dust holder meant the real holders were no longer "the last share" and could exit in full
at a NAV that marks an open naked leg at zero — leaving the slot's proceeds to the dust. It
now gates on what is *left*: `MIN_SUPPLY_WHILE_OPEN`, one whole share.

**First-deposit inflation was live.** No decimals offset and no seed deposit: a one-wei
first deposit plus a donation rounded the next depositor's shares to zero, a total loss.
`_decimalsOffset()` now returns 6.

**`maxWithdraw` and `maxRedeem` lied.** ERC-4626 requires an amount that does not revert;
these reported the full NAV share while a withdrawal is paid out of idle collateral. Both
now return the real ceiling — capped by idle and by the open-slot floor — rather than zero,
so a holder who cannot take everything is still told what they can take.

## The sweep

`releaseSlot` shipped as `voidExpired → syncSettlement → finalizeMarket → _settle` on the
stated belief that the two middle calls were "not optional". Measured on a fork against the
real module: after a bare `voidExpired`, `settle` redeemed **100.000000 of 100**. They are
gone from the callback and kept in the bot, where the gas is the operator's.

`SWEEP_GAS` had been raised to 40,000,000 on that same wrong premise. It did not fit its
own stated worst case (8 × 5,314,308 = 42.5M), and it is paid from the handler's own
balance: at the arm's 50 gwei cap a full 40M sweep costs 2 STT against a measured headroom
of **0.82 STT** over `MIN_HANDLER_BALANCE`. One worst-case callback would have ended arming
permanently. Now 16,000,000, sized on `voidExpired` 694,993 + `settle` 679,349 per slot. A
real callback has measured 291,526 gas, or 0.0047 STT.

## The tests could not catch their own bugs

Seven mutations survived the whole suite. Three are now dead, each on a test written for it:

| Mutation | Caught by |
|---|---|
| `_cancelIfLive`'s `mayFail` guard reverted to clear the id | `test_aRefusedCancelKeepsTheOrderId` |
| `onlyGovernor` removed from `setRiskParams` | `test_onlyGovernorCanSetRiskParams` |
| `onlyGovernor` removed from `setGrid` | `test_onlyGovernorCanSetGrid` |

The first is the one that mattered: the comment above that line describes a real incident —
"a slot was freed, its two legs stayed live, both filled later, and 200 outcome tokens
turned up under a slot that had quoted 100" — and the guard preventing it could be reverted
with 78 of 78 tests still green. `setRiskParams` and `setGrid` had no test of any kind,
including for who may call them; a permissionless `setGrid` lets anyone set `lotSize = 0`
and brick every future quote.

**Four of the five invariants could not fail.** Proved by doubling `_restingEscrow` — a
100% error in the number NAV rests on — and running the suite: only one invariant noticed.
`idleIsTheBalance` was a literal tautology (`idleAssets()` *is* that balance).
`navIsCashPlusRestingPlusCompleteSets` read two of its three terms back out of the contract
it was checking. `noOpenSlotWithoutAShareholder` asserted `totalSupply() > 0`, which the
one-wei attack satisfies — the defect restated as an assertion the defect passes.

Now: the NAV invariant takes its escrow term from the **pool's** books; the tautology is
replaced by "no holder is promised more than idle can pay"; the shareholder invariant
requires `MIN_SUPPLY_WHILE_OPEN`. The fixture gained the venue's expiry freeze, an
`expire()` action so the frozen gap is reachable at all, a donation action, and a second
depositor — with one LP, no invariant about value moving *between* holders was expressible.

## Where the numbers were wrong

The evidence corpus is otherwise clean: **44 of 44** cited transactions exist, behaved as
described, hit the contract named, and match every quoted gas figure and block number.
Three derived numbers did not reproduce and are corrected: a callback credited with a NAV
change it did not make (`totalAssets` was 4622.199998 on both sides; only idle moved), a
stale "before" in the dead-oracle file (4202.422338, not 4185.52 — the +208.90 recovery and
the endpoint were right), and a byte count that was a hex-string length.

`docs/SDK-FEEDBACK.md` had also misidentified a beacon proxy as an access gate; see issue
16, which is the finding that actually explains the two-day freeze.

## Not done

- **The fixes are not deployed.** `scripts/attest.ts` reports MISMATCH. The live vault runs
  the previous build, so on chain the sweep still no-ops on an abandoned window and
  `flatten` still reverts for everyone past expiry. The bot covers both from off-chain.
- **5,061.80 tUSDC is recoverable and unclaimed** — 5,000.00 in a vault at deployer nonce 8
  (`0x5e6b9242Db15959EdCEccBa5C369fca3576fd598`) that appears in no file in this repo, and
  61.80 in v8. `redeem` simulates clean on both.
- **20 STT is permanently stranded** in three pre-`sweepNative` probe contracts (deployer
  nonces 1, 3 and 5): no owner, no governor, no exit of any kind.
- **The vault's STT headroom is 0.82 over the arming floor.** Lower than a worst-case
  callback even at the new `SWEEP_GAS`. It wants funding, not code.
- **The settle sandwich is open.** A naked leg marks at zero and `settle` is permissionless,
  so deposit → settle → redeem is a riskless one-transaction profit funded by existing
  holders. Closing it needs a design decision — an epoch, a fee, or a delayed mark — not a
  patch.
- **The strategy is losing.** It needs an adverse rate under 8.9% and is running at 21.8%.
  No code change here addresses that.
