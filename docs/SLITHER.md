# Static analysis

```
python3 -m slither . --filter-paths "lib|node_modules|test|script" --exclude-informational --exclude-low
```

Slither 0.11.6. First run: 22 findings, four of them real. After the 27th's fixes the
surface is 13 results across three detectors — `divide-before-multiply`, `unused-return`,
and `reentrancy-no-eth` — all accepted below.

## Fixed

| Finding | What was actually wrong |
|---|---|
| `reentrancy-balance` in `settle` | Checks-effects-interactions was inverted: the slot was deleted **after** `module.redeem`. A reentrant call would have found the slot still active and redeemed it twice. The slot is now cleared into memory first, and every value-moving entry point carries `nonReentrant`. |
| `reentrancy-no-eth` in `_arm` | `armed[firesAtMillis]` was written after calling the precompile, so a reentrant path could arm the same instant twice and fire the same sweep twice. The slot is now claimed before the call. |
| `unused-return` on `setOperator` | ERC-6909 `setOperator` returns a bool. Ignoring it meant a token that reports failure instead of reverting would leave the vault able to buy positions and unable to redeem them — discovered at settlement, far too late. Now reverts with `OperatorGrantFailed`. |
| `immutable-states` on `governor` | Slither suggested making it immutable. That would make a lost key unrecoverable, which is worse than the gas it saves. Added a two-step `transferGovernance` / `acceptGovernance` instead: single-step transfer to a mistyped address hands the seat to nobody, permanently. |

The sweep path was found while triaging these. `_onScheduled` was the only
value-moving path without the guard, so a reentrant `settle` during a sweep could
have processed a slot the sweep was halfway through. It now holds the guard.

## Accepted, with reasons

| Finding | Why it stands |
|---|---|
| `divide-before-multiply` in `floorToTick` / `quantize` | `(x / step) * step` **is** the grid snap. Multiplying first would defeat the entire purpose of the function. Annotated for forge-lint at the call site. |
| `unused-return` on `module.markets(...)` | Tuple destructuring with placeholders. Slither reads the ignored positions as discarded return values; the ones we need are bound. |
| Remaining `reentrancy-*` on guarded functions | Slither does not model OpenZeppelin's `nonReentrant`. Every function it names now carries it; see the tests for the behaviour rather than the detector. |

`incorrect-equality` on `redeemed == 0` was on this list until the 27th. The detector was
right about the shape and wrong about the risk, and then a live position proved the whole
check wrong for a different reason: a slot holding only the losing side redeems nothing,
which is a result and not a failure, and reverting on it meant such a slot could never be
closed by anyone. The revert is gone, so the finding is gone with it. The exclusion has
been dropped from CI too — a stale exclusion hides the next real instance.

## Not covered by any of this

Static analysis reads the contracts in isolation. It cannot see that
`BinaryMarketsModule` is a live third-party contract we do not control, and the
guards above assume it is honest about what it pulls and pays. It also says nothing
about adverse selection, which is the risk that actually decides whether the vault
makes money.
