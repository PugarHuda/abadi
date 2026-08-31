# The vault woke itself up — 2026-08-27

The README carried this under "blocked, and honestly so" for two days: a handler must
hold 32 STT before the reactivity precompile will accept a subscription, and the
operator key was down to 0.8. The team funded the wallet. This is what happened next,
in order, including the part that failed.

## Attempt one: it fired, and it ran out of gas

```
vault    0x9895457779a2b9702e3F0a800c597afc175bC88D          (v5)
funded   33 STT                          0x9b31764039f07b9faf3750be6245a56f0609455ba8d97f3ae9ed746ba8f2a246
armSweep 1787846609  (16:03:29 UTC)      0xcab942992a10416b506f31ce9786c820cdbacf464b4cb6aabe18699579b679e8
         subscription id 14245397        block 472734778
```

`requireFunded()` passed for the first time, `subscribe` returned an id instead of empty
data, and `armed[1787846609000]` held it. Then the instant arrived:

```
16:03:29 UTC   block 472736505   from 0x9895…C88D   onEvent   OUT_OF_GAS   gasUsed 500000
```

The precompile called back at the **exact second** asked for. The sender of that
transaction is the handler itself, which is how the explorer surfaces a reactivity
callback. And `armSweep` had hard-coded `gasLimit = 500_000`.

`eth_estimateGas` for the same `onEvent` payload, with `from` set to the precompile's
address, said what it should have been:

```
$ cast estimate $VAULT $(cast calldata "onEvent(address,bytes32[],bytes)" 0x…0100 "[$T0,$T1]" 0x) \
    --from 0x0000000000000000000000000000000000000100
1151045
```

1.15M gas to look at one idle slot and do nothing. A full sweep can cancel two legs and
settle or merge on each of eight slots. The limit is now `SWEEP_GAS = 8_000_000`, sized
from that measurement; the precompile accepts up to 200M and charges for gas used.

From inside the contract, nothing happened: no event, `armed` still set, the
subscription spent. `getSubscriptionInfo` reverts before and after. The only evidence a
failed callback exists is the handler's transaction list on the explorer. Reported as
SDK feedback #9.

## What else changed before the second attempt

The sweep used to hold one reentrancy guard across all eight slots and swallow every
per-slot failure inline. It now makes one guarded external self-call per slot,
`releaseSlot(i)`, and catches each one — so a revert in one slot is isolated and the
guard is held per slot rather than across a loop that calls out eight times. And a slot
whose market has **resolved** is now settled by the sweep, not merely cancelled: the
wake-up closes the lifecycle instead of stopping one step short of it.

That is v6, `0x1aeB3B3cAda938B4fB320884D96471b5D9dDa058`, with the 33 STT moved across
by `sweepNative` — the exit added that morning, because three earlier probes had none
and 20 STT is still sitting in them.

## Attempt two: quote → expire → resolve → settled, with nobody calling it

```
quote    BTC-0-27AUG26-1630   900s tier   0.498 / 0.524   basis 97.40
         0x97e1ea86cc8757258dcb5e852709f57ddc82c4de55e4f25e89aa95266320830d
armSweep expiry + 45s = 1787848245  (16:30:45 UTC)
         0x625f7f57d6f7a8c92dd9087fd1711f76a76b736386e16394c4d04df2c0d9f714
         subscription id 14247477
```

Then the operator key did nothing at all. At 16:30:45 UTC:

```
block 472752861   from 0x1aeB…a058   onEvent   success   gasUsed 397746
  CallbackFired(1787848245060)
  Settled(slot 0, …b2a1, redeemed 100.000000, voided false)
  Swept(1787848245060, slotsReleased 1)

totalAssets  4622.199998  ->  4622.199998     unchanged across the settle
idleAssets   4522.20      ->  4622.20         the redeemed 100 left escrow and became cash
slot 0 free    resting 0.00
```

NAV did not move here, and it is not supposed to. A complete set is already marked at
what it redeems for, so settling only moves the same assets from escrow into cash — NAV
is exactly cash plus resting plus complete sets, which is the invariant the stateful
fuzzer asserts, and the chain holds it across this settlement to the millionth. The
+2.60 on a 97.40 basis, 2.67%, is the whole episode rather than the callback: 4619.60 was
the NAV before the quote was placed, some 9,100 blocks and two and a half hours earlier.

The window resolved, the chain woke the vault, the vault redeemed its own position and
freed the slot. The name is literal now. Both legs had filled during the window — a
complete set — so the 100 came back whole. The exact same path handles a naked leg
(`_settle` redeems what it holds); the isolated per-slot call means one shape failing
cannot stop the others.

> **Retracted 2026-08-30.** This paragraph also claimed the same path handled an
> unresolved-but-expired market, with `_release` pulling the legs. It never did. The pool
> freezes a window's order book from the instant it expires until the market is terminal,
> so both cancels reverted, `releaseSlot` reverted with them, and the per-slot `try/catch`
> swallowed it. The current `_release` does not cancel at all; escrow on an expired window
> comes back only through settlement.
> [`dead-oracle-2026-08-30.md`](dead-oracle-2026-08-30.md)

## The jitter, and the third fix

`CallbackFired` carried `1787848245060`. The arm was for `1787848245000`. The precompile
fires with the millisecond it *actually* ran, 60 ms after the one asked for, and
`_onEvent` cleared `armed[actual]` — a key nothing had ever written — so the entry for
the requested instant stayed set after the sweep had already run. Harmless to the
sweep, wrong as a record, and it would have refused a re-arm of that exact instant.

`_onEvent` now looks up the exact key and falls back to the second it belongs to. Arms
are always whole seconds. Reported as SDK feedback #10: the docs describe the topic as
the scheduled timestamp; it is the fired one.

## The whole lifecycle, on chain, by nobody

| step | who | tx |
|---|---|---|
| quote both sides inside the book | operator key | `0x97e1ea86…` |
| both legs fill, complete set | the market | — |
| window expires and resolves | the venue | — |
| wake up, redeem, free the slot | **the chain, into the vault** | `0x66c0e1ec…` |

Every earlier claim in this repository about keeper-free rolls was a design. This one
is a block number.

## Then it happened again, armed by the bot, on a position that lost

`scripts/bot.ts` quoted `ETH-0-28AUG26-0300` at 02:21 UTC and armed a wake-up at the
window's expiry plus 45 seconds in the same cycle — no human chose the instant. The
market walked away from one leg; the other filled; the vault held a naked side, marked
at zero, and the side lost.

```
block 473130786   03:00:45 UTC   from 0xEF66…1C10   onEvent   success   gasUsed 279055
slot 0 freed      NAV 4765.77 -> 4765.77     the unfilled leg's escrow came back, the
                                             losing tokens redeemed nothing
```

That is the shape the old `settle` refused with `NothingToRedeem` and left stuck forever.
The chain closed it in one call with nobody watching. Two wake-ups, two shapes — a
complete set that paid and a naked leg that did not — both closed by the same path.

The 32.99 STT reserve was then swept back to the operator wallet with `sweepNative`
(`0xd98e2a2a…`). Until the vault holds 32 STT again the bot logs `arm skipped` and its
own settle step covers the slots; the wake-up is a property of the funded vault, not of
the code.
