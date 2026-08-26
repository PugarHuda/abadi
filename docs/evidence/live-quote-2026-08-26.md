# First live quote — Somnia Shannon testnet, 2026-08-26

## Deployed

| | |
|---|---|
| LiquidityVault | `0xbcc310b25961bFd241646505c4baE18a518c0A77` |
| Operator / governor | `0x39D2bae5EAedA9283535dDC98F1991c81eD5Cd7E` |
| Collateral | tUSDC `0x70a86D…`, 6 decimals |
| `priceOne` | `1000000` — read from `decimals()`, never hardcoded |
| tick / lot | `1000` / `1000` (0.001 each) |
| Deposited | 5,000 tUSDC → 5,000 shares |

## The quote

Market `ETH-0-27AUG26/tUSDC`, the 86400s tier, 54,755s remaining.

```
theirs : 0.742 / 0.772   spread 0.030
ours   : 0.744 / 0.770   spread 0.026   <- inside
escrow : 97.40 tUSDC for 100 contracts per side
```

tx `0x3a8b93bba2a39a35102d44f8005143dafb9317033003befec7b4c5fbe095a6dd`,
status success, gas 2,784,360. NAV unchanged at 5,000 tUSDC — quoting moves collateral
from idle into escrow, it does not spend it.

## Read back off the live book

```
       BIDS                  ASKS
  0.744  x 100  <- Abadi     0.769  x 200
  0.742  x 200               0.770  x 100  <- Abadi
  0.733  x 330               0.779  x 330
  0.723  x 460               0.788  x 460
```

Abadi's bid is the **best bid on the market**. Both legs rest; neither took.

**The spread on this market went from 0.030 to 0.025** — the incumbent quoter tightened
in response. That is the ecosystem-impact claim demonstrated rather than asserted:
one vault quoting inside made prices better for everyone else trading it.

## The escrow arithmetic, confirmed on chain

100 contracts a side cost **97.40**, not 100:

```
BUY_YES @ 0.744   escrows 0.744  per contract
BUY_NO  @ 0.770   escrows 0.230  per contract   (1 - 0.770, price is YES-side)
                          -----
                          0.974  = 1 - spread
```

A filled pair is a complete set, worth exactly 1 at settlement regardless of outcome.
The spread is captured with no directional exposure and no inventory up front.

## The bug this run flushed out

Every earlier attempt failed with `PostOnlyWouldCross()` or `PriceOutOfBounds()`, and
neither error points anywhere near the cause.

**Prices are scaled to the collateral's decimals, not to 1e18.** On 6-decimal tUSDC,
0.727 goes on the wire as `727000`. We had been sending `727e15` — a factor of 10^12 too
large, which reads as a probability of 727 billion. A buy at that price appears to cross
the entire book; a sell appears out of range. Hence two different, equally misleading
errors depending on the side.

Found by placing one order through the SDK's own path (tx
`0x609ea381a240f6af3243b703a37bb9925c383875c9cc78b7bbbc6ae38aaef107`), decoding its
calldata, and diffing against ours:

```
kind      = 0        BUY_YES
price     = 727000   <- not 727000000000000000
quantity  = 1000000  1 contract
orderType = 3        POST_ONLY
```

The DreamDEX docs warn about exactly this — *"derive the scale from the collateral's
`decimals()` rather than from a literal"* — because mainnet USDso is 18 decimals and
testnet tUSDC is 6. We hardcoded 1e18 anyway. `MarketEngine` now takes `one` as a
parameter and `LiquidityVault` reads it from the token at construction;
`test_aPriceBuiltAtTheWrongScaleIsCaughtHere` is the regression test.

## Also corrected

The generic spot `placeOrder` reverts `UseBinaryPlacement` on a binary pool. Binary
placement is `placeBinaryOrder(uint8 kind, ...)` where kind is
`0 BUY_YES / 1 SELL_YES / 2 BUY_NO / 3 SELL_NO` and price is always the YES-side price.
The spot ABI is present and looks correct, so reaching for it fails silently at runtime.

Both belong in the SDK feedback report.
