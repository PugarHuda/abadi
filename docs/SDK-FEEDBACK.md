# Feedback on the DreamDEX Event Contracts SDK and docs

From building **Abadi**, a market-making vault on Event Contracts, over 2026-08-26 on
Shannon testnet. Everything below cost us real debugging time and is reproducible.

Ordered by how much time each one cost.

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
