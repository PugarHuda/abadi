# Outcome calibration and spread economics — 2,422 settled markets

Source: `listPastBinaryMarkets` against the Shannon indexer, 2026-08-26. Raw run in
`history-2026-08-26.txt`. Confirmed available by the DreamDEX team in the dev channel:
history is unpruned back to launch (~21 Jul), fills/orders/candles all retained.

## Does UP win more often than a coin flip?

| Tier | n | UP% | SE | z vs 50% |
|---|---|---|---|---|
| 60s | 500 | 49.6 | 2.24 | −0.18 |
| 300s | 500 | 48.6 | 2.24 | −0.63 |
| 900s | 500 | 48.2 | 2.24 | −0.80 |
| 3600s | 500 | 51.0 | 2.24 | +0.45 |
| 14400s | 364 | 51.9 | 2.62 | +0.73 |
| 86400s | 58 | 58.6 | 6.57 | +1.31 |
| **Pooled** | **2422** | **49.96** | **1.02** | **−0.04** |

**No.** Not in any tier, and emphatically not pooled: 49.96% at z = −0.04 is as close to a
fair coin as 2,422 samples can measure. The 86400s tier looks tempting at 58.6% but n=58
and z=1.31 — that is noise, and reading it as signal is exactly the error to avoid.

**Zero voids across all 2,422 markets.** Settlement is reliable; `voidPolicy` handling is
a correctness requirement, not a frequent path.

## What that does to the economics

Live spread measured the same day: **2.9%**, uniform across both assets and all six tiers.

With outcomes at 50/50 and mid at ~0.50:

| Role | Expected value per contract |
|---|---|
| Taker (crosses the spread) | **−1.45%** |
| Maker (collects the spread) | **+1.45%** |

## The number that kills the original ConvictionVault

ConvictionVault was designed to **take** liquidity each window — buy the chosen side at
the ask, redeem, re-enter. Rolling the 900s tier at 10% deployment per window:

```
after 1 day  (96 rolls)   -> 87.0% of deposit
after 7 days (672 rolls)  ->  37.7% of deposit
```

Zero fees do not save it. The spread is the cost, and paying it 96 times a day compounds
into ruin. On the 60s tier (1,440 rolls/day) it is far worse.

**A taker-side Conviction product is not marginally unprofitable. It is structurally
ruinous, and no parameter tuning fixes it.** This is measured, not modelled.

## Consequences

1. **LiquidityVault becomes the primary product.** Making is the side with positive
   expected value on this venue, and the data says so rather than the pitch deck.
2. **ConvictionVault must quote, not cross.** It enters with post-only resting orders
   (`ORDER_TYPE.POST_ONLY = 3`) and accepts non-fill rather than paying 1.45% to be sure.
   Where it must cross — flattening before expiry — that cost is explicit in the UI.
3. **Conviction is honestly an expression tool, not an alpha product.** A user pays the
   spread for the convenience of holding a directional view across windows. Saying so
   plainly is more defensible than a backtest that quietly assumes free entry.

## The caveat that must be stated

A 50/50 outcome distribution does **not** mean a maker earns 1.45% risk-free. A resting
quote is filled preferentially when it is wrong — adverse selection — and that cost is
not visible in outcome frequencies. The true maker edge is 1.45% minus adverse selection,
which can only be measured from fills.

One data point on scale, from the DreamDEX team: a single settled market carried 4,428
orders of which 4,422 were resting orders cancelled without ever trading. Flow is very
thin. That caps adverse selection and it caps revenue at the same time.

**Next measurement:** pull actual fills on settled markets and compute realised
maker P&L, rather than assuming the half-spread is collectable. Until that is done,
+1.45% is an upper bound, not a forecast.
