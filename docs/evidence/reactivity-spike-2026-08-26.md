# Reactivity spike — Shannon testnet, 2026-08-26

Account `0x39D2bae5EAedA9283535dDC98F1991c81eD5Cd7E` (50 STT).
Probe contract `0xE9DC8a36e8f14c85E687eEe26978692dA98cbeab` (10 STT, 4605 bytes of code).

## What worked

- `faucet(uint256)` on tUSDC `0x70a86D…` — 10,000 tUSDC minted, tx `0xdd092c61…`, gas 253,138.
- Contract deployment and funding.
- Live market discovery and order-book reads (see `probe-2026-08-26.txt`).

## What does not work: `subscribe` on the reactivity precompile

`0x0000000000000000000000000000000000000100` · `subscribe(SubscriptionData)`

Parameters were built to match `@somnia-chain/reactivity@0.2.1` exactly —
`scheduleSubscriptionAtTimestamp` composes
`eventTopics = [keccak256("Schedule(uint256)"), numberToHex(timestampMs, {size:32})]`,
`emitter = precompile`, `origin = caller = address(0)`,
`handlerFunctionSelector = toFunctionSelector("onEvent(address,bytes32[],bytes)")`
= `0x53edf33d`, `isGuaranteed = false`, `isCoalesced = false`.

Every combination below reverts with **empty return data**:

| Sender | Handler | Offsets tried | Result |
|---|---|---|---|
| EOA | probe contract | T+30s, +60s, +120s, +300s, +600s, +3600s | revert |
| EOA | EOA | T+300s | revert |
| probe contract | itself | T+75s … T+300s, gas 100k and 1M | revert |
| BinaryMarketsModule | probe | T+300s | revert |
| venue's own MarketCreator | probe | T+300s | revert |
| EOA, `msg.value = 1 STT` | probe | T+240s | revert |

Reproduced identically on both `api.infra.testnet.somnia.network` and
`dream-rpc.somnia.network`. Real `eth_sendTransaction` fails gas estimation with the
same empty revert, so this is not an `eth_call` artefact.

`getSubscriptionInfo(uint256)` reverts for every id tried.

### One thing to be careful about, reported honestly

Early in the session four `eth_call` simulations from the EOA returned plausible
subscription ids (14016488, 14016707, 14016715, 14016910). **None of these reproduced
afterwards**, under identical parameters and fresh timestamps. They are not treated as
evidence that the call ever succeeded, and no conclusion here rests on them.

### Ruled out

- **Clock drift** — chain block timestamp is within 2s of real time (checked against the
  RPC's own `Date` header).
- **Stale timestamp** — swept six future offsets from 30s to 1 hour.
- **Unfunded sender** — probe holds 10 STT; `gasLimit × maxFeePerGas` = 0.02 STT.
- **Wrong selector** — `0x53edf33d` computed independently with `cast sig` and matches
  the SDK's `toFunctionSelector`.
- **`isGuaranteed: true`** — the SDK uses `false`; both were tried.

### Solidity trap found on the way (real, and worth keeping)

The precompile has **no bytecode**. solc emits an `EXTCODESIZE` guard before any normal
external call that returns data, so a plain
`ISomniaReactivityPrecompile(0x…0100).subscribe(...)` reverts with empty data *before the
call is made*. `AbadiReactive` therefore uses a low-level `.call` with manual decoding.
This is a genuine trap and belongs in the SDK feedback report.

### Suspicion, not conclusion

The venue's own `MarketCreator` (`0x5Ce69567…`) reports
`armedBoundary() = 1784532600` — roughly **37 days in the past**, while its markets are
still rolling on schedule. Together with `OracleHub.enableReactivity()` being
owner-gated, this is consistent with reactivity subscriptions being **permissioned or
currently inactive on Shannon**, rather than open to any account. That is a hypothesis,
not a finding.

## Question for the Somnia dev channel

> On Shannon (50312), `subscribe` on the reactivity precompile `0x…0100` reverts with
> empty data for a funded EOA and for a funded contract, with parameters matching
> `@somnia-chain/reactivity@0.2.1`'s `scheduleSubscriptionAtTimestamp`. Is subscription
> creation permissioned, does it require registration, or is the precompile currently
> disabled on testnet? If it is open, what does a minimal working `Schedule` subscription
> look like?

## Consequence for Abadi

The "wakes itself, no keeper" claim cannot be shipped as designed until this is answered.
The fallback is already verified to exist and is used instead, so the build is not
blocked: `finalizeMarket(bytes32)`, `releasePool(bytes32)` and
`pokeOracle(uint256)` are documented **permissionless keeper entries** on
`BinaryMarketsModule`. Rolls become permissionless, profit-motivated, and
contract-verified — trustless and non-custodial, but not zero-actor.

The pitch changes from **"no keeper"** to **"no _trusted_ keeper"**. `AbadiReactive`
stays in the codebase behind a flag: the moment a subscription is accepted, the roll path
upgrades with no redesign.


---

# RESOLVED — answer from the Somnia team, 2026-08-26

Subscription creation is **permissionless** and live on testnet and mainnet. Our failure
had two causes, neither of which produces a distinguishable revert:

### 1. The handler must hold >= 32 STT

Our probes were funded with 5 and 10 STT. Below the floor the precompile rejects
`subscribe` with **empty return data** — identical to what a malformed subscription
returns.

This also explains the behaviour recorded above that we could not account for: four
early `eth_call` simulations from the EOA succeeded, then every later attempt failed
under identical parameters. The EOA started at 50 STT and dropped to **29.34** after
funding three probe contracts. It crossed the 32 STT floor mid-session. Not flaky —
the balance moved.

`AbadiReactive.requireFunded()` now turns this into a named error. Measured on Shannon:

```
requireFunded() ->
0x2305a7aa  Underfunded(uint256,uint256)
  balance  = 27343000000000000000   (27.343 STT)
  required = 32000000000000000000   (32 STT)
```

### 2. The handler must answer ERC-165

`SomniaEventHandler` implements `supportsInterface` for `ISomniaEventHandler`, and its
own comment says this exists so "the Somnia reactivity precompile can reason about
support for reactivity subscriptions". Our hand-rolled handler omitted it. Same empty
revert, different cause.

We now extend the official `@somnia-chain/reactivity-contracts` base rather than
hand-rolling the interface.

### What we had right

The subscription encoding. `SomniaExtensions.scheduleSubscriptionAtTimestamp` builds
exactly what we built: topic0 = `Schedule.selector`, topic1 = `bytes32(timestampMillis)`,
`emitter` = the precompile, `origin` = `caller` = 0. The EXTCODESIZE workaround was also
correct and is what the official library does internally.

### Fee parameters, from the team

```
priorityFeePerGas: 10 gwei
maxFeePerGas:      50 gwei   (>= priority + 6 gwei)
gasLimit:          500_000
```

### One-shot

The callback does not re-arm itself. A rolling position must call `arm()` again from
inside `_onScheduled`, which is why the roll design keeps the next arming inside the
callback rather than in a separate transaction.

### A flaw this found in our own contract

The first `AbadiReactive` had `receive()` and no way out. **20 STT is permanently
stranded** across three throwaway probes:

```
0x481fE34ed995603abdB9998b7eCc8811e2707d87   5 STT
0x8A42c093320ee142284fEC03Ed19dE26a322b187   5 STT
0xE9DC8a36e8f14c85E687eEe26978692dA98cbeab  10 STT
```

A contract that must hold >= 32 STT to function needs an exit by construction.
`_sweepNative` was added; `ReactiveProbe.sweep()` exposes it owner-gated.

### Remaining blocker

Purely arithmetic. Handler `0xE99cE97BfEfA24e832AcD9EaaeBFd59Ab7217821` holds
**27.343 STT** and needs **32**. Short by ~4.7 STT, with 20 more stranded in the old
probes. The faucet needs a browser, so this needs a top-up rather than a code change.
