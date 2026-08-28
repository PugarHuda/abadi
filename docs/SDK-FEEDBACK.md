# Feedback on the DreamDEX Event Contracts SDK and docs

From building **Abadi**, a market-making vault on Event Contracts, on Shannon testnet.
Everything below cost us real debugging time and is reproducible.

Issues 1–6 are from 2026-08-26 and are ordered by how much time each one cost. Issues 7
and 8 are from 2026-08-27, found by settling a real position rather than by reading, and
between them they cost us more than the first six put together — they are appended rather
than reordered so the numbering people have already read stays put.

---

## 1. Prices are scaled to the collateral's decimals, and the errors point elsewhere

**Cost: several hours.** The single worst one.

A probability of 0.727 goes on the wire as `727000` on 6-decimal tUSDC, and as `727e15`
on 18-decimal USDso. We built prices at 1e18 because that is what the gotchas page
discusses, and every order failed.

What makes this expensive is that the revert never mentions price:

| Order kind | Revert with a 10^12-too-large price |
|---|---|
| `BUY_YES`, `SELL_NO` | `PostOnlyWouldCross()` |
| `SELL_YES`, `BUY_NO` | `PriceOutOfBounds()` |

Both are truthful — a price of 727 billion *would* cross the whole book on the bid side
and *is* out of bounds on the ask side — and both send you looking at spreads, book
state, and post-only semantics. We probed the book, swept price ladders, tested all four
kinds, and questioned our understanding of mint-a-pair before suspecting the scale.

The Contracts & Addresses page does warn: *"derive the scale from the collateral's
`decimals()` rather than from a literal"*. But it appears under the collateral table as a
balance concern, and reads as being about token amounts, not about the `price` argument.

**Suggestions**

- State the price scale on the Recipes page, in the first code block, as a comment:
  `// price is scaled by 10 ** collateral.decimals() — 0.727 is 727000 on tUSDC`.
- Add `PriceOutOfBounds` to the Gotchas page next to `InvalidPrice`, with the scale
  mistake as the first thing to check.
- Consider a `ScaleMismatch` style error when a price exceeds `one` by orders of
  magnitude. A price above `10 * one` is never a legitimate order.

**How we found it:** placed one order through `exchange.createOrder`, decoded the
calldata of the resulting transaction, and diffed it against ours. That diff took two
minutes; getting to the idea of doing it took hours.

---

## 2. The spot `placeOrder` ABI is present on a binary pool and always fails

**Cost: about an hour.**

`binaryPoolWriteAbi` exports both `placeOrder(bool isBid, ...)` and
`placeBinaryOrder(uint8 kind, ...)`. Only the second works — the first reverts
`UseBinaryPlacement`.

The comment above them says so. But an integrator reading the ABI export list, or
autocompleting from types, reaches for the familiar spot signature first. It compiles, it
type-checks, and it fails at runtime.

**Suggestion:** do not export the spot placement entries on the binary pool ABI at all,
or name them `placeOrder_DO_NOT_USE_ON_BINARY`. A signature that can never succeed is
better absent than documented.

---

## 3. Reactivity fails identically for two unrelated reasons, both with empty revert data

**Cost: most of a day, plus a question to the dev channel.**

`subscribe` on the precompile at `0x…0100` reverts with **empty return data** when:

1. the handler holds less than **32 STT** on testnet, or
2. the handler does not answer **ERC-165** for `ISomniaEventHandler`.

We hit both at once. With no return data there is nothing to distinguish them from a
malformed subscription, so we spent the day varying topics, fee parameters, timestamps,
`isGuaranteed`, sender type, and RPC endpoint — none of which were the problem.

A detail that made it worse: our EOA started at 50 STT and dropped below 32 mid-session
after funding three probe contracts. Early simulations succeeded and later identical ones
failed, which read as a flaky node and sent us down a wrong path entirely. It was the
balance crossing a threshold we did not know existed.

**Suggestions**

- Give the precompile named errors: `InsufficientBalance(uint256 have, uint256 need)` and
  `HandlerNotErc165(address handler)`. Two custom errors would have saved a full day.
- Put the 32 STT floor in the reactivity SDK's own docs and in
  `@somnia-chain/markets-sdk/reactivity`. It appears in the Somnia platform docs, but a
  developer arriving through the markets SDK never sees that page.
- Have `SomniaExtensions.scheduleSubscriptionAtTimestamp` check
  `address(handler).balance` and revert with a named error before calling the precompile.

**Related tooling note:** Foundry refuses `vm.etch` at `0x…0100` because it treats the
address as a precompile, so a handler cannot be unit-tested against a mock at the real
address. Contracts that hardcode the constant are untestable without a fork. Worth a line
in the docs recommending an overridable address for tests.

---

## 4. The Event Contracts page understates what is listed

The trading page says *"BTC and ETH markets on 15-minute and 1-hour windows today"*.

Measured live on 2026-08-26, the venue runs **six tiers**: 60s, 300s, 900s, 3600s,
14400s, 86400s, on both assets — twelve concurrent series.

This matters more than a doc nit. We sized an expiry-headroom rule against the documented
tiers; a rule tuned for 15-minute windows rejects the 60s and 300s tiers outright, and a
fixed 300-second buffer consumes a third of a 900s window. Anything that treats headroom
as a constant instead of a fraction of `intervalSec` silently stops trading the fast
tiers.

**Suggestion:** list the tiers, or say they are configurable and point at
`intervalSec`.

---

## 5. `winningOutcome()` was removed and now reverts

Settlement v3 stores a payout vector; the winner is the argmax of `payoutNumerators`.
This is handled correctly inside the SDK and mentioned in a source comment, but a reader
of the market ABI sees `winningOutcome` in indexer rows and reasonably assumes the
on-chain getter exists.

**Suggestion:** one line on the Settlement page — *the winner is the argmax of
`payoutNumerators`; `winningOutcome()` is gone.* Also worth noting that a **voided**
market has no argmax at all and both sides must be redeemed; redeeming only the "winner"
silently abandons half the position.

---

## 6. Smaller things

- **`getAutoPullRequirement` and `somiPaymentPerOrder` are spot-only.** Both are in the
  ABI surface and both revert on a binary pool. `getAutoPullRequirement` is exactly what
  a vault wants before sizing an order against its balance — a binary equivalent would be
  genuinely useful, since gotcha #7 (underfunded bots looping on reverting orders) is the
  problem it solves.
- **The indexer intermittently returns `RegistryMarkets failed: fetch failed`.** Roughly
  one call in five during our session; retries succeed. Worth a note recommending
  retry-with-backoff, since a bot that treats it as fatal will die at random.
- **`precision.price = 3` is the real tick grid** and is only visible on the market row,
  not in the docs. Combined with issue 1, the grid and its scale are the two numbers an
  integrator most needs and neither is written down together.

---

## 7. Redemption pulls through the **module**, and nothing says so until settlement

**Cost: a stranded position worth 100 tUSDC.** The most expensive one we hit.

Buying outcome tokens needs no ERC-6909 approval at all — a Buy YES crossing a Buy NO
mints a fresh pair and the pool credits the holders directly. Nothing pulls. So a
contract can quote, fill, hold a complete set, and mark it correctly, with no grant
anywhere.

Redemption is the first operation that pulls, and the puller is the **module**, not the
pool the orders went to:

```
outcomeToken.setOperator(binaryMarketsModule, true)
```

Without it, `redeem` and `mergeCompleteSet` both revert:

```
cast call $MODULE "redeem(uint32,bytes32,bytes32,uint8,uint256)"     0 0x00 $MARKET_ID 0 100000000 --from $VAULT
Error: execution reverted, data: "0xdeda9030"     # InsufficientPermission()
```

Three things make this expensive rather than merely annoying:

1. **The failure is invisible for the entire life of the position.** Everything works
   until the one call that turns tokens back into money, and by then the window has
   resolved and left the live market list.
2. **The error does not name a spender.** `InsufficientPermission()` has no arguments, so
   it does not say *which* contract needs approving — and the pool is the natural guess,
   because the pool is what the orders were sent to and what the collateral was approved
   for.
3. **The SDK does know.** `trade.ts` carries the comment *"the trader approves whichever
   contract pulls the escrow: the pool for orders/sets, the module for redeem"*, and
   `orders.js` has a helper that approves the **pool**. A contract integrator reading the
   write path finds the pool grant and no reason to suspect a second one exists.

**Suggestions**

- Put the module grant in the Settlement page's first code block, next to the redeem
  call, not only in an SDK source comment.
- Give `InsufficientPermission` the spender it wanted: `InsufficientPermission(address
  owner, address spender)`. One argument turns a two-hour hunt into a one-line fix.
- Consider a view — `canRedeem(address owner)` or similar — that a contract can assert on
  at construction rather than discovering at settlement.

**How we found it:** by isolating the failing call. Our vault's `settle()` reverted with
empty data; calling `module.redeem` directly with the vault as `--from` produced the real
custom error, and `isOperator(vault, module)` returned false.

---

## 8. `cancelOrder` reverts on an order that already filled

**Cost: one bricked slot and 43.80 tUSDC.**

A two-sided quote stores two order ids. When the market takes one side and walks away
from the other, the natural cleanup is to cancel both:

```solidity
if (yesOrderId != 0) pool.cancelOrder(yesOrderId);
if (noOrderId  != 0) pool.cancelOrder(noOrderId);
```

The filled id is no longer a live order the caller owns, so the pool answers:

```
0xf5e39c1f  IncorrectSender(0xbCAe987E…, 0x51fdca2e…)
```

and the whole cleanup reverts. The result is that cancellation works on every slot except
the one shape that actually needs cancelling — the one carrying directional risk with a
dead quote resting against it. Ours had no exit at all: cancel reverted on the filled id,
merge refused for want of a complete set, and redemption refused because the side we held
lost.

The fix on our end is a `try/catch` per leg, which is fine once you know. Knowing requires
either reading the pool's source or losing a position.

**Suggestions**

- Make cancelling a non-live order a **no-op** rather than a revert. Cancellation is
  idempotent in intent: the caller wants the order gone, and it is.
- If it must revert, `IncorrectSender(caller, owner)` is the wrong shape for this case —
  the caller is not a different owner, the order is simply finished. `OrderNotLive(id)`
  would send integrators to the right conclusion immediately.
- Either way, say on the Gotchas page that a stored order id is not evidence the order is
  still cancellable, and that batch cancels need per-order isolation.

**How we found it:** a live one-sided fill on a 3600s BTC window, then simulating all
three exits against the resolved market. All three reverted.

---

## 9. A reactivity callback that runs out of gas vanishes without a trace

**Cost: one subscription, and the afternoon it took to find out where it went.**

Subscription creation is permissionless and the 32 STT floor is documented in the
resolution above. What is not documented is what happens when the callback itself fails.
Our first live wake-up on Shannon was armed with `gasLimit = 500_000`. It fired at the
exact millisecond asked for — the scheduler is precise — and ran `OUT_OF_GAS`:

```
16:03:29 UTC  block 472736505  from 0x9895…C88D  onEvent  OUT_OF_GAS  gasUsed 500000
```

From the handler's side nothing happened: no event, `armed[...]` still set, the
subscription simply spent. `getSubscriptionInfo(id)` reverts with empty data before and
after, so there is no read that says "fired, failed". The only place the failure exists
is the explorer's transaction list for the handler address, where the sender is the
handler itself.

`eth_estimateGas` for the same `onEvent` payload with `from` set to the precompile's
address returned **1,151,045** for a sweep that touched one idle slot and did nothing —
so a 500k limit was never going to work, and nothing on the way said so.

**Suggestions**

- State a floor. If a callback commonly needs a million gas before doing any work, the
  reactivity docs should say so next to `gasLimit`, and `SomniaExtensions` could refuse
  a limit under it the way it refuses a fee gap under 6 gwei.
- Surface the outcome. A `getSubscriptionInfo` that returns `{fired, success, gasUsed}`
  after the instant would have turned a forensic exercise into one call.
- Estimate for people. The precompile knows the handler and selector; a
  `estimateCallbackGas(subscription)` view, or a note that `eth_estimateGas` with
  `from = 0x…0100` works, would let arming be sized from a measurement.

**How we found it:** the explorer's `/addresses/{handler}/transactions`, filtered to
`onEvent`. Then `cast estimate` from the precompile address.

---

## 10. The `Schedule` topic is the fired millisecond, not the scheduled one

**Cost: a stale mapping entry and an hour of reading logs.**

A handler that keys its own state by the instant it asked for — the natural thing to do,
since that is the only number it has at arm time — cannot find that state when the
callback arrives:

```
armed for   1787848245000
topic[1]    1787848245060       CallbackFired, block 472752861
```

Sixty milliseconds of scheduler jitter. `SomniaExtensions.scheduleSubscriptionAtTimestamp`
documents the topic as the scheduled timestamp; on Shannon it is the actual one. The
callback itself is on time to the second, so this is a documentation gap and not a
scheduling fault — but a handler written to the documentation deletes the wrong key.

**Suggestions**

- Say so in the docs, one line: *the topic carries the fire time, which may trail the
  scheduled time by tens of milliseconds.*
- Better: include the scheduled instant as well, either as a second topic or in `data`,
  so a handler can match on what it asked for.
- Failing both, recommend keying by second in the handler pattern.

**How we found it:** decoding the callback's `CallbackFired` topic against the value
passed to `armSweep`, after `armed[...]` was still set following a successful sweep.

---

## 11. The explorer's verifier advertises `osaka` and cannot verify it

**Cost: two days of an unverified live address, and every route tried twice.**

`GET /api/v2/smart-contracts/verification/config` lists `osaka` among
`solidity_evm_versions`, and forge's default target for solc 0.8.30 is osaka. Every
submission of the vault — the Etherscan-style route via `forge verify-contract`, the v2
`standard-input` route, the v2 `flattened-code` route — was accepted and then reported
`Fail - Unable to verify`. Settings, sources, and constructor arguments all matched what
was deployed; `scripts/attest.ts` confirms the artifact and the chain bytecode agree.

The isolating experiment was a nine-line contract deployed twice from the same toolchain:

```
--evm-version osaka    0x5e89175C7CE79D494C2CB44Fe5728584AAD9a4AD    Fail - Unable to verify
--evm-version cancun   0xe4DB4F1edd1EB74A28111eDE373E89b19CE5ed6f    Pass - Verified
```

Same source, same compiler, same optimizer, same explorer. Only the EVM target differs.

**Suggestions**

- Either verify osaka builds or drop `osaka` from the advertised list. A version that is
  listed and silently fails costs far more than one that is absent.
- Say which target to use in the Foundry deployment guide. One line —
  `evm_version = "cancun"` in `foundry.toml` — would have saved every attempt above.
- Return the compiler's diagnostic. `Unable to verify` for a bytecode mismatch and for an
  unsupported target look identical from outside.

**How we found it:** by giving up on the real contract and verifying something too small
to have any other reason to fail.

---

## What was genuinely good

Not padding — these saved us real time:

- **The Gotchas page is excellent.** On-chain status over indexer status, expiry in
  nanoseconds, pool recycling, and "loadMarkets cannot find your winnings" were all
  correct and all mattered. We built `MarketEngine` directly from that list.
- **Historical data is complete and reachable.** `listPastBinaryMarkets` +
  `getMarketResolution` let us measure outcome calibration across 2,422 settled markets
  before writing a line of strategy code. Very few venues make that possible, and the dev
  channel answer confirming nothing is pruned was the single most useful reply we got.
- **The SDK ships its ABIs and its sources.** `npm pack` and reading `src/` answered
  questions the docs could not. `binaryModuleWriteAbi`'s comments about permissionless
  keeper entries were load-bearing for our design.
- **Zero fees are real and they change what is buildable.** A market maker requoting
  continuously is only viable because of it.
- **The dev channel answered a hard question in under an hour**, with a working minimal
  contract. That answer unblocked us completely.

---

## Reproducing any of this

Everything above is backed by recorded output in `docs/evidence/`:

| File | What it shows |
|---|---|
| `probe-2026-08-26.txt` | live markets, six tiers, the 2.9% spread |
| `calibration-2026-08-26.md` | 2,422 settled markets, UP won 49.96% |
| `reactivity-spike-2026-08-26.md` | the full reactivity investigation and its resolution |
| `live-quote-2026-08-26.md` | the working quote, and the calldata diff that found issue 1 |
| `stale-deployment-2026-08-27.md` | issue 7 — the isolation that produced `InsufficientPermission` |
| `one-sided-fill-2026-08-27.md` | issue 8 — all three exits reverting on a live slot |
| `first-settle-2026-08-27.md` | `settle` and `flatten` succeeding once both were fixed |
