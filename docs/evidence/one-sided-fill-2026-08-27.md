# What a one-sided fill breaks — 2026-08-27

The redeployed vault quoted two windows and both moved against it the same way. On the
hour tier BTC ran from 0.55 to 0.79; on the day tier ETH ran from 0.34 to 0.38. In each
case the BUY_NO leg was taken and the BUY_YES leg was left behind, far under a market
that had walked away from it.

```
slot 0  ETH-0-28AUG26        quoted 0.330 / 0.354   book now 0.364 / 0.393
        holds  up 0.00   down 100.00      NAKED 100.00
slot 1  BTC-0-27AUG26-0400   quoted 0.536 / 0.562   book now 0.783 / 0.808
        holds  up 0.00   down 100.00      NAKED 100.00
```

That is adverse selection, and it is the risk a maker is paid the spread to carry. It is
not a bug. What it exposed underneath is.

ETH later came back down through the resting bid and slot 0 completed into a full set
— 100 UP + 100 DOWN against a 97.60 basis, the mechanism doing exactly what it is for.
BTC never came back. That contrast is the whole product: the same quote, one window
paying the spread and one window paying for the move.

## Every exit reverted

```
cancelQuote(1)  ->  0xf5e39c1f  IncorrectSender(vault, 0x51fdca2e…)
flatten(1)      ->  0x2eb88305  NothingToFlatten(0xaa9f)
settle(1)       ->  0x45c770c1  MarketNotSettled(0xaa9f, TRADING)
```

`flatten` refuses a slot with no complete set — correct, there is nothing to merge.
`settle` refuses a market that has not resolved — correct, it has not. `cancelQuote` is
the one that should have worked, and it is the one that is broken:

```solidity
if (s.yesOrderId != 0) pool.cancelOrder(s.yesOrderId);
if (s.noOrderId != 0) pool.cancelOrder(s.noOrderId);
```

Both ids, unconditionally. Once a leg fills, its id is no longer a live order the vault
owns, and the pool answers `IncorrectSender`. So the exit is available on every slot
except the one shape that needs an exit: the slot carrying directional risk.

And when the window did resolve against the held side, `settle` had a matching refusal:

```solidity
if (redeemed == 0) revert NothingToRedeem(id); // reverts, so the clear above unwinds
```

A slot holding only losing tokens redeems nothing. Written as a safety check, it means a
losing slot can never be closed by anyone, by any path, ever.

`_release` — the reactivity sweep — already wrapped its cancels in `try/catch`. The
defence existed. It existed in the one path a human never calls.

## NAV was reporting money that was gone

`totalEscrowed` was a stored counter, incremented at quote time and decremented at exit.
Nothing decremented it at *fill* time, because a fill is not a call the vault makes. So
after a one-sided fill the counter still claimed the full escrow while half of it had
become directional tokens, and `totalAssets` added the tokens only when they formed a
complete pair. A naked leg was carried at exactly what it cost.

Measured on the live vault, mid-position:

```
reported NAV                        4902.60 tUSDC
  cash                              4707.60
  resting escrow (unfilled legs)     33.00  + 53.60
  complete sets                       0.00
true NAV                            4794.20
                                   ---------
overstated by                        108.40   ( 2.21% )
```

`totalAssets()` is what ERC-4626 prices shares against. A depositor arriving at that
moment would have bought in against 108.40 of collateral that no longer existed, and
taken a share of a loss that had already happened.

## The fix

`_cancelIfLive` is one guard in one place, and all four exits route through it:

```solidity
function _cancelIfLive(IBinaryPool pool, uint128 orderId) internal {
    if (orderId == 0) return;
    try pool.cancelOrder(orderId) {} catch {}
}
```

`settle` now pulls the resting leg before redeeming — a resolved market will never fill
it, and leaving it there strands its escrow at the pool — and no longer reverts when the
held side lost. The slot clears; that *is* the result.

`totalEscrowed` stopped being stored. It is derived from what is still resting:

```solidity
function _restingEscrow(Slot storage s) internal view returns (uint256 resting) {
    if (s.yesOrderId != 0) { ... if (yes < s.size) resting += costOf(s.size - yes, s.bidPrice); }
    if (s.noOrderId  != 0) { ... if (no  < s.size) resting += costOf(s.size - no,  mirror(s.askPrice)); }
}
```

A filled leg holds no escrow because its balance covers its size. A cancelled leg holds
none because its id is zero. There is no counter left to fall out of step, and five
mutation sites went with it.

`totalAssets` marks a naked leg at nothing. A complete set is worth exactly its size
whichever side wins, so it is counted in full; a leg without a partner is a directional
bet whose value is unknown until settlement, so it counts for zero. NAV may understate.
It may not overstate — that is the direction that takes money from whoever arrives next.

## Why sixty-two tests missed all of it

```solidity
function cancelOrder(uint128 orderId) external {
    cancelled.push(orderId);
}
```

The mock pool recorded the cancel and returned. It never reverted on a dead id, and it
never handed the escrow back — so a test could not tell the difference between escrow
returned and escrow stranded, and could not reach the `IncorrectSender` path at all.

The mock is now built to the pool's actual manners: it reverts `IncorrectSender` on a
filled id, it transfers the resting collateral back on a successful cancel, and
`fillPartial` takes escrow the way a fill does. Three defects fell out of that change
before a line of the fix was written.

A mock kinder than the thing it stands in for does not test the code. It tests the mock.

Sixty-five tests now, and the four that matter here are the ones a passing suite could
not previously have contained.

## The fix had a hole of its own

Making `cancelQuote` survive a filled leg immediately made it dangerous. It ends with

```solidity
delete _slots[slot];
```

unconditionally — which was safe only because the old version could never reach it on a
slot that had bought anything. Now it could, and `settle` is the only function that can
redeem outcome tokens. Deleting the slot orphans them on the ERC-6909 with nothing left
that can reach them, and the side that looks dead today is the side that pays on the
market that goes the other way.

So the slot is now kept whenever it still holds either outcome, and freed only when it
holds neither. Two tests: one that cancels, resolves the other way, and redeems 100
anyway; one that cancels a slot which bought nothing and gets the slot back.

Sixty-seven tests. A fix that is not tested against the thing it just made reachable is
half a fix.

## The check that was missing

```
$ node scripts/attest.ts
address  0xDFb9C6fA99D8Fa2c8eeA2AE7C055C8cbA53971E9
553 bytes differ, against 1024 bytes of immutables they are allowed to differ in
MATCH  the live address is running this source
```

Deployed runtime bytecode against the build artifact, immutable slots masked out because
those are constructor arguments burned into the code and differ by design. Anything
outside them means the address is not this source.

It is twenty lines and it answers the question that cost 97.40 tUSDC.
