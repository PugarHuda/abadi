# The two windows that would not close, and the hatch that was open all along

**2026-08-30, Shannon (50312). Vault `0x2314436ed2BDC44321c74EF43adA14CAE723D352`.**

## What the log said

`ETH-0-28AUG26-1600` (`…c08f`) and `BTC-0-28AUG26-1600` (`…c090`) expired at 16:00 UTC
on the 28th. Two days later they were still unresolved, and the keeper log had the same
four lines every fifteen minutes:

```
15:41:42 pull     slot 0 c08f  rejected: The contract function "cancelQuote" reverted…
15:41:44 poke     slot 0 c08f  success  0xd751404c…  gas 125918
15:41:50 pull     slot 2 c090  rejected: The contract function "cancelQuote" reverted…
15:41:52 poke     slot 2 c090  success  0x8f2ad570…  gas 125918
15:41:57 cycle 1  NAV 4434.82  idle 4185.52  resting 249.30
```

196.00 tUSDC of the vault's escrow sat behind those two slots the whole time.

## What was actually wrong

`cancelQuote` reverted `CancelFailed(orderId, 0x8afbce93)`. That selector is in no
4byte entry, no verified explorer source, and not one of the 418 errors in the SDK's own
generated `contractErrorsAbi` — the table the SDK itself warns is generated from
`smart-contracts/src/**` and therefore misses the OrderBook base in the dex submodule.

Simulating every cancel path the venue offers, from the vault's own address:

```
cancelOrder(id)                     0x8afbce93
cancelOrders([ids])                 0x8afbce93
cancelExpiredOrders([ids])          0x8afbce93
sweepExpiredAtLevel(isBid,px,5)     0x8afbce93
```

All four. Including the two the SDK documents as "permissionless keeper drains …
callable by anyone on a binary pool". **The pool freezes its entire book at expiry.**

The boundary was then measured exactly, on a fork of Shannon, against a live 24h window
(`…d525`, expiry 1788134400, settlementWindow 300), cancelling as the order's owner at
four instants:

| t − expiry | `cancelOrder` | `voidExpired` |
|---|---|---|
| −5   | ok           | `0xe114c921` |
| +1   | `0x8afbce93` | `0xe114c921` |
| +295 | `0x8afbce93` | `0xe114c921` |
| +315 | `0x8afbce93` | **ok** — and `cancelOrder` works again immediately after |

So the freeze starts at expiry, not at `expiry + settlementWindow`, and it lifts the
moment the market goes terminal. There is no grace period in which escrow can be pulled.
Escrow on an expired window comes back exactly one way: the market settles.

## The way out

`BinaryMarket.voidExpired()` — permissionless, gated on
`block.timestamp >= expiry + settlementWindow`. `settlementWindow` on these windows is
**300 seconds**. Both markets had been voidable since 2026-08-28T16:05:00Z. The hatch was
open for two days while the bot poked an oracle that was never going to answer.

It writes the market directly and bypasses the module, so two more permissionless calls
are needed before anything can be redeemed: `syncSettlement` releases the hub earmark the
adapter never released, and `finalizeMarket` moves the pool's backing into settlement.

## Recovery, on chain

```
16:45:46 void     slot 0 c08f  success  0x4cf9b22222e0fe77948a198f69ba0174d6280f6c41a40f2885b68683e2db03c8  gas 694993
16:45:48 sync     slot 0 c08f  success  0x9179fcc37604b174b31f9d26e989aa751c16d7446ec45927df53881fd4a46c12  gas 2322671
16:45:50 final    slot 0 c08f  success  0x89de5f7853f89ff6af69d9b9e38e62287d5aa077155f75001f519669dd478787  gas 1617295
16:45:53 settle   slot 0 c08f  success  0x3e08aa3e391424e1b44ee7abf2a4f54e61b5276eb3c145881b86b267a74f8796  gas 679349
16:46:01 void     slot 2 c090  success  0x43bae7de19dd7d8f51bc33a8a38921647f1d6c01c64c1982c3660819d65d1dd2  gas 694993
16:46:03 sync     slot 2 c090  success  0x9866768d0892590b6bc65a2ec22b99320af7acc9d77a12fb8b39801745692631  gas 2322671
16:46:05 final    slot 2 c090  success  0x5c8d456467b7e2f101d79fc0ef24d4417ab9989e9cca3e338f86ee593f050b80  gas 1617295
16:46:07 settle   slot 2 c090  success  0x6bf33028da2d7b058c2e8fdf016977420bc5d8925e1f4edc522ded7fa38ecf48  gas 258414
```

Decoded from those two settle receipts:

| slot | basis | pool returned | settlement returned | total back |
|---|---|---|---|---|
| 0 `…c08f` | 97.60 | 60.50 | 50.00 (100 YES at the voided 0.5) | **110.50** |
| 2 `…c090` | 98.40 | 98.40 | 0.00 (held nothing) | **98.40** |

208.90 back on 196.00 of basis. `idleAssets` went 4185.52 → 4215.52 and equals the vault's
real tUSDC balance to the cent; the rest went straight back out as two new quotes in the
same cycle. Slot 2 came back at exactly 100% of its basis — the escrow the frozen book
would not hand over was returned by the pool on finalization anyway.

## What this broke that nobody had noticed

The frozen book does not only affect the bot. It reverts `_cancelIfLive`, and that
function is on the way out of **every** exit the vault has:

- **The keeper-free sweep did nothing on the one shape it exists for.** `_release` opened
  with two cancels; past expiry both revert, `releaseSlot` reverts with them, and
  `_onScheduled`'s per-slot `try/catch` swallows it. The only live sweep on record worked
  because that window had already resolved and took the `_settle` path.
- **`flatten` could not be called by anyone.** Its contract says the operator may flatten
  any time and *anyone* may flatten once the market can no longer trade — "past that point
  no fill is possible, so there is no value left to destroy". Past that point the cancel it
  opens with reverts, so the promise was empty exactly where it was made. A unit test
  asserted otherwise, against a mock pool that allowed the cancel.

Both are fixed in this commit. **Neither fix is live until the vault is redeployed.**

## The fix

- `_cancelIfLive` takes `mayFail` and returns whether the pool is done with the id. A
  refusal is survivable exactly when no fill is possible — when the market can no longer
  trade — and is survived by *keeping* the order id, never by clearing it. A slot is
  deleted only when nothing is resting and nothing is held.
- `releaseSlot` takes the hatch: `voidExpired`, then `syncSettlement`, then
  `finalizeMarket`, then `_settle`. Each wrapped, because a callback that reverts is lost.
- `_release` no longer cancels at all. It merges a complete set if there is one and keeps
  the slot; only settlement can return what the pool still holds.
- `SWEEP_GAS` 8,000,000 → 40,000,000. One slot through the hatch measured 5,314,308.
- The bot arms the wake-up at `expiry + settlementWindow + 15`, not `expiry + 45`. At +45
  the market is not resolved, not voidable, and its book is already frozen: the sweep
  arrived with nothing it could do.
- The bot's expired-window branch stops calling `cancelQuote` and `pokeOracle` into the
  void. It pokes while the oracle still has time and voids once it does not.

## Proof

`test/fork/Venue.fork.t.sol::test_fork_sweepFreesAWindowTheOracleAbandoned` — against the
real pool and the real market on a fork: quote a live window, warp to `expiry + 1`, confirm
the real pool refuses the cancel and the real market refuses the hatch, confirm
`releaseSlot` changes nothing and keeps both the slot and its escrow, then warp past
`expiry + settlementWindow` and watch the vault void, sync, finalize, settle and free the
slot with every cent of the escrow back. 5 fork tests pass.

Unit: `test_sweepVoidsAWindowTheOracleAbandoned` and
`test_sweepInTheGapKeepsTheSlotAndWhatIsOwedOnIt`. The mock pool now freezes its book at
expiry the way the real one does, and the mock market has the hatch on the real clock gate
— which is what turned the `flatten` defect from invisible into a failing test. 78 unit
tests pass.

## Unrelated, same evening

At 17:00:45 UTC the reactivity precompile fired the wake-up the bot had armed at 16:27,
and the vault settled slot 1 (`…e050`) by itself — `CallbackFired`, `Settled`,
`Swept(released 1)` in tx
`0x2f75001ea73bd66cf62649841542a2d8b74cad22afa1513e5e6463730a009f50`. That window
resolved, so it took the path that already worked.
