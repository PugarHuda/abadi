# The vault gets an opinion of its own

**2026-08-31, Shannon (50312). Vault `0x2314436ed2BDC44321c74EF43adA14CAE723D352`,
operator `0x39D2bae5EAedA9283535dDC98F1991c81eD5Cd7E`.**

An audit graded this project's venue integration a D against its own claim of "deep
integration", and named the cause exactly: **Abadi had no independent opinion of fair
value.** Everything `priceInside` produced was derived from the incumbent's own bid and
ask, then moved two ticks closer to the money:

```ts
const mid  = (theirBid + theirAsk) / 2;
let   half = (theirAsk - theirBid) / 2 - 2 ticks;
```

When the incumbent is stale, that is stale **and two ticks worse**. It is a machine for
buying adverse selection, and the ledger agrees: 20% of filled quotes went one-sided
against a strategy that breaks even near 9% adverse, and depositors are down 6.84%.

The venue has shipped the missing input the whole time — a standalone price-feed indexer
with a `Feed` catalog, a 1/s `PricePoint` tape and M1/H1/D1 `Candle` rollups, auth-free at
`https://price-feed.dev.oracle.somnia.host/v1/graphql`. This project had never made a
single call to it.

## The model

A DreamDEX event contract is a digital call. "BTC closes at or above its opening price"
pays 1 if `S_T >= K` and 0 otherwise. Under lognormal dynamics with zero drift,

```
S_T = S · exp(−σ²T/2 + σ√T · Z),      Z ~ N(0,1)
P(S_T ≥ K) = N( (ln(S/K) − σ²T/2) / (σ√T) ) = N(d₂)
```

which is the closed form, not an approximation of it. `scripts/lib/fairvalue.ts` computes
it. The normal CDF is Abramowitz & Stegun 7.1.26 (`|error| < 1.5e-7`), eleven lines, no new
dependency. The drift is left at zero deliberately: over the 15 minutes to 4 hours these
windows run, any real drift is far inside the estimation error on σ.

Four inputs, all from the venue:

| input | source | SDK verb |
|---|---|---|
| spot `S` | `Feed` catalog row, with the `updatedAtMs` that says whether the oracle is still writing | `listPriceFeeds` |
| strike `K` | the market row when it has one; the feed tick at `tradingStart` when it does not (below) | `fetchPriceHistory` |
| `T` | `expiry − now`, over a 365-day year | market record |
| `σ` | EWMA of log returns on M1 candle closes | `fetchPriceCandles` |

## The strike, which is not written down

Two shapes of binary market are live on Shannon and they answer this question differently.

The `Pricefeed test:` series carries a real strike on its market row and even in its symbol
— `BTC-7755364-31AUG26-0441/tUSDC`, `strike: "7755364"`, question "will BTC/USDC's price be
at or above **77553.64**". So that field is 1e2-scaled. That scale is **inferred from the
question text, not from a documented constant**, so `fairProbability` refuses any strike
more than 10× away from spot rather than trusting it blind — a scale misread would
otherwise produce a confident `0.000` instead of an error.

Every window Abadi has ever quoted is the other shape. This venue's own rolling series asks
"BTC closes at or above its **opening** price" and carries `strike: "0"` — on the indexer row
and in the symbol (`BTC-0-31AUG26-0800/tUSDC`). The on-chain `markets(bytes32)` getter does
not return a strike at all. **The boundary is not recorded anywhere; it is whatever the feed
read at `tradingStart`.**

So it is read back from the feed's tick tape at that instant — and that is checkable rather
than assumed. At `tradingStart = 1788150600` (2026-08-31T04:30:00Z):

```
PricePoint  blockTimestamp 1788150600  spot 77505.05     ← the feed's first tick of that second
Market      0x…e908  tradingStart 1788150600  strike "7750505"
            "Pricefeed test: will BTC/USDC's price be at or above 77505.05 at unix time 1788150660?"
```

The venue's own fixed-strike window, opened at the same second, wrote down exactly the
number the feed tape gives back. Same for ETH at that second (2412.44). That is the
justification for the reconstruction, and it is the strongest one available — but it is
still a reconstruction, not a read of the number the market will settle against.

## The volatility, and how weak it is

EWMA on log returns of M1 candle closes:

```
r_t = ln(close_t / close_{t−1})
v_t = λ·v_{t−1} + (1−λ)·r_t²      seeded with the sample second moment of the window
σ   = √(v · 525,600)              minutes in a 365-day year
```

- **λ = 0.94** (`FV_LAMBDA`), the RiskMetrics decay. On 1-minute bars that is a half-life of
  about **11 minutes**, so a 4-hour window is priced off the last quarter-hour of movement.
- **240 M1 candles** (`FV_VOL_CANDLES`), i.e. a 4-hour lookback; **239 usable returns** in
  every run below.
- Returns spanning a **missing** candle are dropped, not kept. The feed does skip minutes,
  and a 3-minute move counted as a 1-minute return inflates σ by √3.
- Under 30 usable returns, the module refuses to produce a number at all.

**This is a weak estimator and the model should not be trusted past its precision.** A
few hundred minute bars off a testnet oracle is a small sample; λ = 0.94 makes it local
rather than representative; and the lognormal tail is thinner than crypto's, so N(d₂)
understates exactly the tail events a binary pays on. Measured across the six live windows
below, the model's σ ran **6 to 15 vol points above** the level implied by the book — the
disagreement is about volatility, not direction.

## Against live markets, 2026-08-31 ~04:40 UTC

`node scripts/probe.ts`, which now prints this table on every run. `sigma` is the model's;
`implied` is backed out of the book's own mid through the same closed form, for comparison.

| market | tier | left | book mid | fair | edge | σ model | σ implied by the book | would quote? |
|---|---|---|---|---|---|---|---|---|
| `ETH-0-01SEP26` | 86400s | 69572s | 0.468 | 0.479 | 0.011 | 37% | 21.9% | YES |
| `BTC-0-01SEP26` | 86400s | 69571s | 0.424 | 0.453 | 0.028 | 29% | 17.4% | YES |
| `ETH-0-31AUG26-0800` | 14400s | 11969s | 0.340 | 0.368 | 0.028 | 37% | 30.0% | YES |
| `BTC-0-31AUG26-0800` | 14400s | 11969s | 0.275 | 0.336 | 0.061 | 29% | 20.6% | YES |
| `ETH-0-31AUG26-0500` | 3600s | 1168s | 0.107 | 0.143 | 0.036 | 37% | 31.6% | YES |
| `BTC-0-31AUG26-0500` | 3600s | 1167s | 0.042 | 0.089 | 0.047 | 29% | 22.8% | no — near-certain (`EDGE`) |

The per-row inputs the bot logs alongside each:

```
ETH-0-01SEP26/tUSDC        spot 2414.97   strike 2416.83  (feed tick at tradingStart+0s)  d2 -0.053  239 M1 returns, λ 0.94, feed 1s old
BTC-0-31AUG26-0800/tUSDC   spot 77560.19  strike 77745.70 (feed tick at tradingStart+0s)  d2 -0.422  239 M1 returns, λ 0.94, feed 4s old
```

Every one of the six is out of the money (spot below the opening price — the market had
fallen since each window opened) and on every one the model sits **above** the book. That
is not six independent confirmations; it is one observation, made six times, that our σ is
higher than the book's. Said plainly: **this snapshot does not show the model beating the
book. It shows the model and the book disagreeing about volatility, and the model is the
side with 239 minute bars of testnet data behind it.** The value being claimed here is the
refusal and the lean, not an alpha.

## In the bot: two changes, opt-in, default-safe

`FAIR_VALUE` unset is byte-for-byte today's behaviour, and says so:

```
04:45:34 fv       OFF  quoting off the incumbent's book alone (set FAIR_VALUE=1 for the model)
04:46:33 skip     BTC-0-31AUG26-0800/tUSDC  mid moved 3 ticks in 20s — trending, not quoting
04:46:36 cycle 1  NAV 4450.07  idle 4385.87  resting 64.20  share 0.949983
```

**1. Refuse a window the book and the model disagree about** (`FV_MAX_EDGE`, default 0.10).
Run with it tightened to 0.02 so all three live candidates trip it:

```
04:47:48 fv    BTC-0-31AUG26-0800/tUSDC  fair 0.326  spot 77546.45 strike 77745.70 (feed tick at tradingStart+0s)
                                         sigma 30.0% on 239 M1 returns (lambda 0.94)  11534s left  d2 -0.450  feed 1s old
                                         book mid 0.275  edge 0.051
04:47:48 skip  BTC-0-31AUG26-0800/tUSDC  book mid 0.275 vs fair 0.326 — 0.051 apart, over FV_MAX_EDGE 0.02;
                                         one of us is wrong and the spread will not pay for finding out which
04:47:48 skip  ETH-0-31AUG26-0500-E937/tUSDC  0.337 vs 0.385 — 0.048 apart
04:47:49 skip  BTC-0-31AUG26-0500-E936/tUSDC  0.423 vs 0.452 — 0.028 apart
04:47:51 cycle 1  NAV 4450.07  idle 4385.87  resting 64.20  share 0.949983
```

**2. Skew the quote toward fair value**, bounded by `FV_SKEW_TICKS` (default 3). The mid
moves; `minHalfSpread` and the venue's tick/lot grid do not, and the existing no-cross
checks still gate the result. A real quote, on chain:

```
04:45:09 fv     ETH-0-31AUG26-0800/tUSDC  fair 0.359  spot 2415.03 strike 2420.74 (feed tick at tradingStart+0s)
                                          sigma 34.4% on 239 M1 returns (lambda 0.94)  11691s left  d2 -0.360  feed 3s old
                                          book mid 0.342  edge 0.017
04:45:09 quote  slot 0 ETH-0-31AUG26-0800/tUSDC  theirs 0.327/0.357  ours 0.332/0.358  size 100  escrow 97.40
                                          (mid still, 2 ticks)  skew +3 ticks toward fair
04:45:13 quote  slot 0 e8af  worked  0xff8bfa75f09b5d0f94f5f769043692619f5e1ca24ef9db12f9e321add450e4e7  gas 992266
04:45:18 arm    08:05:15Z    worked  0x408d4a6b52c62d46d0aaa94e4ada54e6aea3239e3df4f93f8e0198d4ca568867  gas 465755
04:45:22 cycle 1  NAV 4483.27  idle 4385.87  resting 97.40  share 0.957070
```

Book mid 0.342, model 0.359, quote centred at 0.345 rather than 0.342 — three ticks, the
cap, because the model wanted more than three. Half-spread 0.013 either side, unchanged.
Without the lean the same quote would have rested at 0.329/0.355.

### It never quotes on a stale model, and never dies of one

Feed unreachable — `PRICE_FEED_URL` pointed at a 404. Every candidate logs the failure and
the cycle falls back to exactly the old behaviour:

```
04:48:59 fv    BTC-0-31AUG26-0800/tUSDC  NO MODEL: @somnia-chain/markets-sdk: indexer price-feed
                                         PriceFeeds failed: HTTP 404 — quoting on the book alone
04:49:02 cycle 1  NAV 4450.07  idle 4385.87  resting 64.20  share 0.949983
```

Feed answering but stale — the same refusal, driven by `Feed.latestUpdatedAtMs` against a
local clock (`FV_MAX_FEED_AGE`, default 120s; forced to 0 here to fire it):

```
04:50:14 fv    BTC-0-31AUG26-0800/tUSDC  NO MODEL: BTC feed last written 1s ago, over the 0s limit
                                         — quoting on the book alone
```

The stale number is never used for anything. Both runs exited 0.

Offline arithmetic check: `node scripts/lib/fairvalue.ts --self-check` — N(0), N(±1.96),
N(6), monotonicity in spot, the ATM small-`x` expansion, and the near-symmetry about the
strike (which is 0.9962, not 1.0000; the −σ²T/2 term is a real asymmetry and the test
asserts its size rather than pretending it away).

## Two SDK verbs the audit named, and why they are still unused

**`reduceOrder`** — the in-place shrink that keeps price-time queue priority where
cancel-and-replace loses it — and **batch `cancelOrders`**, which returns `bool[]` and is
best-effort on chain. Both are genuinely the right primitives for a requoting maker.

**Neither is reachable from the bot, and no change to the bot can make them reachable.**
`LiquidityVault` mediates every order this operator key can cause: custody is the vault's,
and the operator's entire surface is

```
quote(slot, marketId, mid, halfSpread, size)     cancelQuote(slot)
armSweep(firesAtSec)                             disarmSweep(firesAtSec)
```

There is no path from an operator key to a pool order id. Exposing `reduceOrder` means a
new external on `LiquidityVault` — a `src/` change, outside this task's file ownership, and
a change to the custody boundary that should be argued on its own merits rather than
smuggled in as SDK coverage. Recorded here as a finding, not delivered as a fix.

Worth noting for whoever picks it up: `cancelOrders` is one of the four cancel paths
measured in `dead-oracle-2026-08-30.md` as reverting `0x8afbce93` on any expired window, so
its batch semantics buy nothing in the one situation where a batch cancel would be most
wanted. `reduceOrder` is the one with real value — a maker that trims size on a moving book
instead of cancelling and re-queueing keeps its place in the queue, which is most of what
being early is worth.

## What is not claimed

- **No backtest.** The model has never priced a window that has since resolved. Everything
  above is a snapshot, and the ledger cannot yet say whether the refusal rule lowers the
  20% one-sided rate.
- **The estimator is thin.** 239 minute bars from a testnet oracle, λ = 0.94, no
  jump/fat-tail term, no term structure. It is defensible; it is not good.
- **The strike for the rolling series is reconstructed**, and only cross-checked against the
  venue's fixed-strike twin at one instant. If the venue ever takes its opening price from
  something other than the feed tick at `tradingStart`, every probability above is wrong by
  whatever that difference is, and nothing in the bot would notice.
- **The skew cap is the safety, not the model.** Three ticks is what stands between a bad σ
  and a quote somewhere silly. It is deliberately small enough that the model can only ever
  be a lean, never a decision.

## Files

`scripts/lib/fairvalue.ts` (new), `scripts/lib/quoting.ts` (`Candidate` carries `asset` /
`strike` / `tradingStart`; `priceInside` takes an optional bounded skew), `scripts/bot.ts`
(the two uses + the knobs), `scripts/probe.ts` (question 3 — the table above).
`npx tsc --noEmit` clean.

## Switched on, and the first window it refused

The model landed in `16cd74d` and then sat unused: every scheduled keeper run between that
commit and 09:12Z logged `fv OFF`, because `scripts/keeper.cmd` never set the flag. It sets
`FAIR_VALUE=1` now.

The two runs either side of that line priced the same window, ninety seconds apart.
Book-only, at 09:11:59Z:

```
09:11:59 quote  slot 0 BTC-0-31AUG26-1200/tUSDC  theirs 0.790/0.815  ours 0.792/0.812
                size 100  escrow 98.00  (mid still, 2 ticks)
09:12:03 quote  slot 0 eb78  worked  0x86a06617f42c8ffa9bcbf2e0f51b1f0f98904ad7a828abc3ae3cf56e6e08d7a4  gas 592266
```

With the model, at 09:13:31Z:

```
09:13:31 fv    BTC-0-31AUG26-1200/tUSDC  fair 0.674  spot 78610.55 strike 78196.52
               sigma 64.8% on 239 M1 returns (lambda 0.94)  9989s left  d2 0.452  feed 1s old
               book mid 0.805  edge 0.131
09:13:31 skip  BTC-0-31AUG26-1200/tUSDC  book mid 0.805 vs fair 0.674 — 0.131 apart,
               over FV_MAX_EDGE 0.1; one of us is wrong and the spread will not pay for
               finding out which
```

The book-only quote had already gone one-sided by the time the model refused it. Read off
the chain immediately after, with the quote pulled:

```
idleAssets     4397.072338
totalAssets    4456.572338
totalEscrowed    59.500000     (98.00 rested; 38.10 of it is no longer resting)
totalSupply    4684.372338     share 0.951368, from 0.959504 one cycle earlier
```

**What this is not.** One window is not a backtest, and part of that 8.1-tick fall in share
price is the live build's own marking: the deployed `_restingEscrow` infers fills from an
ERC-6909 balance, so a leg that fills stops counting as escrow without the outcome tokens it
bought counting as anything else. The audited replacement reads `quantityRemaining` from the
pool, and is not deployed. The honest claim is narrower and still worth having: the model's
first production decision was to refuse a window the previous rule had just taken, on a
BTC disagreement of 0.13 that the probe shows on both BTC tiers at once — 0.786 vs 0.661 on
the daily and 0.803 vs 0.667 on the four-hour. A gap that size and that one-directional is
either a stale incumbent or a wrong sigma, and until a resolved window says which, refusing
is the cheaper of the two errors.
