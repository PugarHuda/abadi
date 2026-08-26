# Abadi Protocol — Design Spec

**Date:** 2026-08-26
**Target:** Somnia × DreamDEX Event Contracts Hackathon (deadline 2026-09-08/09)
**Status:** Spikes executed 2026-08-26. Reactive core built and unit-tested. SteadyVault
cut on evidence; LiquidityVault replaces it. See §5 and §18.

---

## 1. What Abadi is

Prediction markets on DreamDEX expire and vanish. Abadi is a protocol layer that makes
them holdable.

You deposit once. The protocol carries your position across every subsequent window,
driven by its own Somnia reactivity subscription armed at each window's expiry — no
keeper, no cron, no server.

Precise claim, because the imprecise version is wrong: Abadi does **not** ride the
oracle's settlement callback. `BinaryMarketsModule` is the only address a market trusts
as its settler and the hub's `enableReactivity()` is owner-gated. Abadi holds its **own**
subscription against the Somnia reactivity precompile at `0x0100`, armed at expiry — the
same mechanism the venue's own `MarketCreator` uses to roll market series (§18).

On that foundation sit four products:

| Product | What it gives you | Risk |
|---|---|---|
| **Liquidity** | Spread captured by zero-inventory two-sided quoting | Adverse selection, no directional view |
| **Conviction** | Sustained directional exposure across unlimited windows | Directional |
| **Streak** | Consecutive-window parlays with compounding payoff | High variance |
| **Open Questions** | Prediction markets on any question, AI-resolved | Varies |

---

## 2. The problem

Every Event Contract expires and is replaced by a successor. Measured live on 2026-08-26,
the venue runs **six interval tiers** — 60s, 300s, 900s, 3600s, 14400s, 86400s — on BTC
and ETH. That is **twelve concurrent series**, and the docs' claim of "15-minute and
1-hour windows" is out of date. Consequences:

- You cannot hold a view longer than one window without manually re-entering.
- The 60s tier is 1,440 windows a day. No human manages that by hand.
- Capital fragments across dozens of concurrent windows.
- Every user re-enters and pays the spread again, every single window.
- The spread is a flat ~2.9% on every market regardless of tenor — one naive quoter.
- Winnings do not auto-redeem. DreamDEX's own docs state `loadMarkets()` cannot find
  your winnings; finalized markets vanish from the live list.

The result feels like a slot machine rather than a financial instrument. The two other
hackathon submissions (Market Dungeon, QDS) both build *on top of* this foundation
without addressing it.

Two protocol properties make it fixable, and they exist nowhere else:

1. **Zero fees** (maker, taker, settlement). Rolling a position 1,440 times a day on the
   60s tier costs nothing. On a venue with a 0.1% taker fee the same behaviour consumes
   the entire position inside a day.
2. **On-chain reactivity.** A contract arms itself against the `0x0100` precompile and
   wakes at a wall-clock instant. Elsewhere this requires a keeper network paying gas per
   user per window.

---

## 3. System at a glance

```
┌───────────────────────────────────────────────────────────────┐
│  SURFACES                                                     │
│  PWA (Next.js) · Telegram Mini App · MCP server (agents)      │
└──────────────────────────┬────────────────────────────────────┘
                           │ viem / wagmi
┌──────────────────────────▼────────────────────────────────────┐
│  ABADI CONTRACTS (Solidity, Somnia)                           │
│                                                                │
│  ┌──────────┐ ┌────────────┐ ┌────────┐ ┌──────────────────┐ │
│  │ Liquid.  │ │ Conviction │ │ Streak │ │ OpenQuestions    │ │
│  │ Vault    │ │ Vault      │ │ Vault  │ │ + OracleAdapter  │ │
│  └────┬─────┘ └─────┬──────┘ └───┬────┘ └────────┬─────────┘ │
│       │             │            │               │            │
│       └─────────────┴──────┬─────┴───────────────┘            │
│                            ▼                                   │
│                  ┌──────────────────┐                          │
│                  │   MarketEngine   │  shared library          │
│                  │  quantize · gate │                          │
│                  │  place · cancel  │                          │
│                  │  mint · merge    │                          │
│                  │  redeem sweep    │                          │
│                  └────────┬─────────┘                          │
│                           ▼                                    │
│                  ┌──────────────────┐                          │
│                  │  AbadiReactive   │ ← precompile 0x0100      │
│                  │  onEvent()       │   self-armed at expiry   │
│                  └──────────────────┘                          │
│                                                                │
│  ┌──────────────────┐  ┌──────────────────┐                   │
│  │ TrancheRouter    │  │ AbadiDelegate    │ EIP-7702 for EOAs │
│  │ senior/junior    │  │ atomic multicall │                   │
│  └──────────────────┘  └──────────────────┘                   │
└──────────────────────────┬────────────────────────────────────┘
                           │
   DreamDEX  BinaryMarketsModule · MarketsCore · Pool CLOB
             OutcomeToken6909 · OracleHub · CollateralRouter
```

### DreamDEX addresses (identical on testnet 50312 and mainnet 5031, CREATE3)

| Contract | Address |
|---|---|
| BinaryMarketsModule | `0x3ecC694Cef705358864a646142ac17A90E29e388` |
| MarketsCore | `0x2802504314685D89bF6C992CA5a8e7cC78bc0294` |
| BinarySettlement | `0xbF4a49e0Dfd092e5FBE8E5761064C49533e6Ed23` |
| OutcomeToken6909 | `0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9` |
| OracleHub | `0xe40db387cC98601Dd11bd634fF2f3AD5686dE32b` |
| CollateralRouter | `0xbC0C9834B15ACE38bB50dDaa7d7f7C7CC4DC183C` |

Collateral: testnet **tUSDC** `0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E` (6 decimals);
mainnet **USDso** `0x00000022dA000002656c64D9eA6011ea952D008A` (18 decimals). Read
`decimals()` at runtime — never hardcode.

Venue ID (testnet):
`0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c`

---

## 4. Layer 0 — MarketEngine

A shared internal library. Every vault routes through it. This is where all thirteen
documented SDK sharp edges are paid for exactly once.

**Responsibilities**

- `liveMarkets(venueId)` — discovery, filtered by on-chain status
- `assertTradable(marketId)` — reads live on-chain status; only `Trading` (1) accepts
  orders. The indexer lags by seconds and must never gate a write.
- `quantize(marketId, amount)` — snap to the pool's lot grid; return 0 if it floors to
  zero. `amountToPrecision` skips lot sizing on binary markets before SDK 0.24.0.
- `toTick(price)` — integer tick conversion. Never pass a float: `(0.05).toFixed(18)`
  yields `"0.050000000000000003"`, three wei off-grid, rejected as `InvalidPrice`.
- `place(marketId, side, isBid, tick, lots, expiryNs)` — wraps `placeOrder`. Sets
  `expireTimestampNs` always; `0` reverts with `OrderAlreadyExpired`. Expiry is capped
  at market expiry and set just past the requote interval as a dead-man's switch.
- `mintSet` / `mergeSet` — 1 collateral ⇄ 1 Up + 1 Down
- `sweepRedemptions(venueId, limit)` — `listBinaryMarkets({status: "Finalized"})`, then
  `redeem` per held outcome. Finalized markets are invisible to `loadMarkets()`.
- `headroom(market)` — expiry buffer as a *fraction of `intervalSec`*, not a fixed
  number. A hardcoded 300s threshold burns a third of every 15-minute window and would reject a 5-minute series outright if one is ever listed.

**Invariants**

- State is keyed by `marketId` or symbol. **Never by pool address** — pools are recycled
  across windows. Where a pool must be distinguished, use `(poolAddress, nonce)`.
- Market metadata is read from typed fields (`asset`, `strike`, `intervalSec`). The
  question text changes across versions and is never parsed.
- Every write checks the receipt. SDK writes skip simulation and resolve even when the
  transaction reverted.

**Why one library:** four vaults × thirteen sharp edges is fifty-two chances to get it
wrong. Centralising makes the second vault nearly free, which is the only reason
building four products in this timeframe is coherent at all.

---

## 5. Layer 1 — LiquidityVault (replaces SteadyVault — parity harvest is DEAD)

### What the probe killed

SteadyVault was to harvest complete-set parity: `bid(Up) + bid(Down) > 1` means mint a
set, sell both, lock the excess. **It cannot happen here.** Measured on the live testnet
book, 2026-08-26 (`docs/evidence/probe-2026-08-26.txt`), across eleven markets and all
six interval tiers:

```
ask(Down) = 1 - bid(Up)     exact to 6 decimals, every market
bid(Down) = 1 - ask(Up)     exact to 6 decimals, every market
bid-sum + ask-sum = 2.000000 identically
```

There is only **one** book. The Down side is a rendered mirror of the Up side, not an
independent order flow. A deviation from parity is therefore structurally impossible,
and the product has no yield to harvest. Cut, on evidence, not on judgement.

### What the same probe revealed instead

Every market on the venue is quoted at a **flat ~2.9% spread**, identical across both
assets and all six tiers, at three levels of depth:

| Market | Up bid | Up ask | Spread |
|---|---|---|---|
| BTC 15m | 0.6800 | 0.7080 | 0.0280 |
| ETH 15m | 0.5880 | 0.6170 | 0.0290 |
| BTC 1h | 0.9330 | 0.9540 | 0.0210 |
| BTC 4h | 0.4710 | 0.5010 | 0.0300 |
| ETH 24h | 0.7140 | 0.7420 | 0.0280 |

A uniform spread on every market regardless of tenor, volatility or moneyness is the
signature of a single naive quoter, not a competitive book. That is the opening.

### The product

A zero-inventory market maker, run as a vault.

`mint-a-pair` means a resting Buy Up at `p` and a resting Buy Down at `1-p` together
form a complete two-sided quote **with no inventory at all** — two opposite-side buyers
cross with no seller, and the pool mints the pair from their combined collateral. With
zero maker and taker fees, quoting inside a 2.9% spread costs nothing per requote.

- Depositors supply collateral, receive ERC-4626 shares.
- The vault quotes both sides inside the incumbent spread across the tiers where flow is
  worth having.
- Revenue is captured spread plus DreamDEX's own maker yield on resting collateral.
- Risk is adverse selection near expiry: widen as a fraction of `intervalSec` remaining,
  then pull entirely inside the final headroom.

This is strictly better for the submission than the parity product would have been. It
generates trading activity directly — the judging rubric's own words — and it tightens
spreads for every other user on the venue, which is the one thing the sponsor most wants.

## 6. Layer 2 — ConvictionVault (persistence exposure)

### What this instrument actually is

**It is not a perpetual future, and we will not call it one.**

A perp long on BTC that rises 5% makes 5%. Conviction does not track magnitude at all.
It pays on how *often* the asset closes up, versus the probability the market priced.

That makes it a distinct instrument class: **persistence exposure**. You are betting
that BTC closes up more frequently than the market implies — not that it rises by any
particular amount.

This framing is both more honest and more novel than "synthetic perp". A judge who
knows derivatives will probe this within thirty seconds; leading with the honest answer
converts the hardest question into the strongest moment.

### Mechanics

User deposits margin `M`, picks asset `A`, direction `D`, and a conviction level `f`
(the fraction of balance deployed per window).

Per window `i`:

```
premium  p_i = f × B_i
quantity     = quantize(p_i / q_i)       q_i = entry probability
if D wins:   B_{i+1} = B_i − p_i + quantity        (each contract redeems 1:1)
if D loses:  B_{i+1} = B_i − p_i
if voided:   B_{i+1} = B_i − p_i + quantity × 0.5  (both sides redeem at 0.5)
```

At `q ≈ 0.5` each window is close to an even-money coin flip on the deployed fraction.
With `f = 0.20` and 96 windows a day, balance variance is enormous. Therefore:

- `f` is user-selected and capped: **Low 5% · Medium 10% · High 20%**
- A **floor** auto-exits the position when balance falls below a user-set percentage of
  the original deposit
- The UI shows a Monte Carlo fan chart of the balance path for the chosen `f` **before**
  the user deposits

Hiding the decay would destroy credibility with judges and lose users money. Showing it
plainly proves we understand what we built.

### The roll — the core "only on Somnia" claim

```
window expires
   → oracle posts settlement answer
   → Somnia on-chain reactivity delivers the event to the hub callback
   → SettlementHook.onSettle(marketId, outcome)
   → ConvictionVault redeems the winning side
   → enters the next window of the same series
```

No keeper. No cron. No server. Anywhere else this needs a keeper network paying gas per
user per window, and the economics collapse.

### Batched rolls

If two hundred users roll in the same second, two hundred transactions is not viable.
Positions are pooled per `(asset, direction, conviction level)` bucket. One roll moves
the whole bucket; individual users hold shares of the bucket. Day-1 spike #5 (gas cost
per roll) determines the bucket granularity.

### Void handling

A voided market redeems both sides at 0.5. The roll must continue without stranding
funds. Two permissionless backstops exist on DreamDEX and Abadi calls both:
`pokeOracle(questionId)` retrieves a posted answer; `voidExpired()` voids a market whose
settlement window closed with no answer.

---

## 7. Layer 3 — TrancheRouter (senior / junior waterfall)

Originally cut as over-engineering; re-included on request. This is the only component
that turns two independent vaults into one capital structure.

### Structure

```
                    ┌──────────────────┐
   Senior deposit ─►│                  │
                    │  Combined pool   │
   Junior deposit ─►│                  │
                    └────────┬─────────┘
                             │ deployed to Liquidity + Conviction
                             ▼
                     period returns R
                             │
              ┌──────────────┴──────────────┐
              ▼                             ▼
    Senior claim first:            Junior receives:
    min(R, seniorRate × S)         R − seniorPaid
                                   (negative → junior absorbs)
```

- **Senior** receives a fixed target rate (e.g. 8% APR) with first claim on all returns.
  Backed primarily by Liquidity's near-risk-free yield.
- **Junior** is first-loss. It absorbs any shortfall against the senior rate, and in
  exchange receives leveraged exposure — effectively borrowing senior capital at the
  fixed rate to run Conviction.

### Why this is the hardest component

- NAV must be computed across two vaults with different settlement cadences.
- A solvency check must prevent junior from ever wiping senior: junior capital must
  cover the maximum single-period drawdown of the deployed Conviction position. That
  bound is a function of `f` and the number of concurrent windows.
- Withdrawal ordering matters. Senior withdrawing during a junior drawdown must not
  crystallise a loss onto remaining junior holders.
- Period boundaries must be defined precisely when the underlying rolls every 15 minutes.

**Recommendation:** build this last, and only if Layers 0–2 are solid by Day 10. It adds
real capital-structure sophistication but adds nothing that a judge can see in a
three-minute video that Layers 1–2 do not already show.

---

## 8. Layer 4 — StreakVault (structured products)

Multi-strike volatility surfaces were cut: settlement validates against the window's
**opening price**, so strikes are at-the-money only and there is no strike ladder to
build a surface from.

Consecutive windows, however, compose perfectly — and they reuse the Conviction roll
infrastructure almost entirely.

### Mechanism

"BTC closes up N windows in a row."

```
window 1: buy Up with stake s
  win  → roll ENTIRE proceeds into window 2 Up
  lose → position dead, stake gone
… repeat N times
payout ≈ s × ∏(1 / q_i)
```

At `q = 0.5`: 3 in a row ≈ 8×, 5 in a row ≈ 32×.

### Why it earns its place

- **Marginal build cost is near zero** — it is the Conviction roll with "reinvest
  everything" instead of "deploy a fraction", and a terminal window count.
- **Highest demo value of any component.** Lottery-shaped payoff, fully on-chain
  fairness, a live counter ticking through streak windows. It is the shot that makes a
  three-minute video memorable.
- Somnia's own hackathon history rewards this shape — ScratchWins was featured on
  38 players and 224 cards, purely because the usage was real and legible.

---

## 9. Layer 5 — Open Questions (AI-resolved markets)

Highest ceiling, highest risk. Event Contracts today cover BTC/ETH up-down only. The
entire prediction-market TAM lives in non-price events.

### Design

```
proposer posts question (natural language) + resolution source + bond
   → OracleAdapter registers a market via BinaryMarketsModule
   → market trades normally on the DreamDEX CLOB
   → at expiry, a Somnia Agent queries the source, runs a deterministic model,
     and consensus-validates the answer
   → answer posted to OracleHub
   → dispute window opens
   → unchallenged → settles; challenged → escalates, loser's bond slashed
```

Somnia Agents natively query APIs, run deterministic AI models, and scrape the web with
consensus validation. This is the primitive the layer rests on.

### Blocking unknown

**Is market/oracle-question creation permissionless?** Unverified. This is Day-1 spike
#6 and it is binary:

- **Permissionless** → build it. This is the single largest TAM expansion available to
  DreamDEX and it lands us squarely in Somnia's 2026 roadmap (reactive features +
  prediction markets + AI).
- **Permissioned** → cut immediately, present as a roadmap slide with the adapter
  interface designed. Do not spend a second day on it.

### Honest limitation

"AI resolves disputes correctly" is not provable in a three-minute demo, and a judge is
right to be sceptical. If built, demo it on a question with an unambiguous
machine-readable source (a sports score, a block height, a published index value) — not
on anything genuinely contestable.

---

## 10. Layer 6 — AbadiDelegate (EIP-7702 EOA path)

For users who will not deposit into a vault. A 7702 delegate contract that lets a plain
EOA perform atomic multi-step actions self-custodially: `approve + place`,
`place + place` across both sides, `redeem + re-enter`.

The bot kit ships `DreamDexVolumeBatch7702` as a working reference, and its docs confirm
the pattern generalises to `place + place across pairs`.

**Two traps, both documented:**

1. When self-sponsored, the authorization must be signed at `nonce + 1`, because the
   transaction itself consumes the current nonce.
2. Without `executor: "self"` in viem, the delegation silently fails and no contract
   code executes — no error is raised.

Value: it makes Abadi usable by people who reject pooled custody entirely, and it is a
credible "power user mode" in the demo. Cost: roughly two days, mostly spent on those
two traps.

---

## 11. Layer 7 — Consumer surfaces

One Next.js codebase, two targets.

**PWA (mobile-first web)** — primary. Full UX control, standard wallet connect, trivial
Vercel deploy, easy to record for the demo video.

**Telegram Mini App** — same codebase, Telegram wallet flow. Strongest distribution and
the strongest adoption narrative, at the cost of roughly one extra day once session keys
work.

Screens:

- **Liquidity** — deposit, realised APY, and a live "directional exposure: 0.00" readout
  running alongside a monotonically rising balance. That pairing is the proof.
- **Conviction** — asset, direction, conviction level, floor. Monte Carlo fan chart
  before deposit. Live roll feed showing every automatic roll as it happens.
- **Streak** — pick N, stake, watch the counter advance window by window.
- **Portfolio** — positions across all vaults, auto-claim status, history.

**Session keys** (supported by the bot kit) remove the signature popup on every action.
Without them the one-tap experience does not exist.

---

## 12. Layer 8 — MCP server (agent surface)

DreamDEX advertises native MCP support and lists autonomous agents alongside
institutions as a first-class user. Somnia brands itself the Agentic L1.

Expose Abadi as MCP tools — `abadi.liquidity.deposit`, `abadi.conviction.open`,
`abadi.streak.enter`, `abadi.portfolio` — so any agent (Claude included) operates the
protocol in natural language.

Cheap to build once the contracts exist (it is a thin typed wrapper). Aligns hard with
both sponsors' positioning. Weak on its own — terminal output does not carry a demo
video — which is exactly why it belongs as a layer here rather than as the headline
(the reason Idea 3 was not chosen as the main project).

---

## 13. Layer 9 — Social / copy-trading

Somnia has already rewarded this shape: **Mirra**, a reactive copy-trading protocol
where one leader swap cascades across seven contracts in the same block, was featured in
the Reactivity hackathon.

Applied to Conviction: a leaderboard ranked by realised persistence accuracy, and a
follow button that mirrors a leader's direction changes reactively.

Deliberately ranked last. It is derivative of a known winner, and every hour spent here
is an hour not spent on the roll engine that makes Abadi itself novel.

---

## 14. Token — designed, deliberately not shipped

Requested, so it is designed. It is also the one item I recommend against shipping.

**Design:** `ABADI` accrues a share of Liquidity's spread income and Conviction's
performance fee. Stakers direct emissions toward under-liquid market series.

**Why it stays out of the submission:** across six prior Somnia hackathons, no featured
or winning project won on tokenomics. A token in a hackathon submission reads as
speculation-first to exactly the judges we need, and Somnia's own materials repeatedly
emphasise applications "beyond speculation". It costs judge trust and buys no rubric
points.

Ship it post-hackathon if the protocol earns real usage. It appears in the deck as a
roadmap item, not in the code.

---

## 15. Data flow — one Conviction roll, end to end

```
t=0    user deposits 100 tUSDC, picks BTC / Up / Medium (f=0.10), floor 50%
       ConvictionVault assigns shares in bucket (BTC, Up, 0.10)

t=0+   MarketEngine.assertTradable(currentMarket)        ← on-chain status, not indexer
       quantize(10 / q)  where q = best ask on Up
       place(marketId, UP, isBid=true, tick, lots, expiryNs = min(requote, marketExpiry))
       receipt checked — SDK writes do not simulate

t=5m   window expires → oracle posts answer
       Somnia reactivity → OracleHub → SettlementHook.onSettle(marketId, outcome)

       outcome = UP:
         redeem winning outcome tokens 1:1
         bucket balance updated, shares unchanged
         discover next market in series, re-enter
       outcome = DOWN:
         premium lost, bucket balance updated, re-enter
       outcome = VOID:
         both sides redeem at 0.5, re-enter

       floor check: bucket balance < floor → exit position, funds idle, user notified

t=∞    repeats until user withdraws
```

Every arrow after `t=5m` runs with no off-chain participant.

---

## 16. Error handling

Derived from the thirteen documented gotchas plus this protocol's own failure modes.

| Failure | Handling |
|---|---|
| Indexer lag | Every write gated on live on-chain status. Indexer used for discovery only. |
| Silent revert | Check `(order.info as PlaceOrderResult).receipt`. Reverts resolve rather than throw. |
| `InvalidPrice` | All prices as integer ticks. No float ever reaches the SDK. |
| Order floors to 0 | `quantize` returns 0 → skip the market. Never send a zero-size order. |
| `OrderAlreadyExpired` | `expireTimestampNs` always set, never 0, capped at market expiry. |
| Underfunded loop | Balance checked against chain state before signing. A reverted write does not throw, so an underfunded bot will otherwise loop paying gas forever. |
| Pool recycled mid-flight | State keyed by `marketId`; `(poolAddress, nonce)` where a pool must be identified. |
| Market locks mid-flight | Adaptive headroom as a fraction of `intervalSec`. Skip markets inside the buffer. |
| Winnings unfindable | `sweepRedemptions` via `listBinaryMarkets({status:"Finalized"})`, not `loadMarkets()`. |
| Oracle never answers | `pokeOracle(questionId)`, then `voidExpired()`. Both permissionless. |
| Roll fails | Position parks as idle collateral inside the vault. Never stranded, never silently retried into a locked market. |
| Quote leg-2 revert | Whole transaction reverts. A contract is atomic by construction, so a one-sided quote can never be left resting. |
| Wrong venue | All queries scoped by `VENUE_ID`. Never inferred. |

---

## 17. Testing

- **Foundry unit tests** per contract. Mint/merge invariant (`mint(x)` then `merge(x)`
  returns exactly `x`), quantization boundaries including the floors-to-zero case, tick
  conversion against known-bad values such as `0.05`.
- **Fork tests** against Somnia testnet using real DreamDEX contracts. This is the only
  way to test the reactivity callback path honestly.
- **Waterfall property test** (if Layer 3 ships): across randomised return sequences,
  senior principal must never be impaired while junior capital remains.
- **One end-to-end script** driving deposit → roll → settle → redeem → withdraw on
  testnet, runnable in a single command. This doubles as the demo script.
- Dry-run mode from the bot kit stays on by default for anything touching a live venue.

---

## 18. Spike results — verified 2026-08-26

Verified against raw docs (`.md` source, not summaries), the live testnet RPC and REST
API, and the shipped ABIs inside `@somnia-chain/markets-sdk@0.28.1` (`npm pack`, read
`src/`). Not yet verified by executing a transaction.

| # | Question | Result |
|---|---|---|
| 1 | Can a contract call `placeOrder` and hold outcome tokens? | **YES.** `placeOrder` auto-pulls input from the caller and auto-delivers proceeds back to the caller; a contract caller is the order owner and holds the tokens. If the payout transfer fails, the pool credits the contract's vault (`PayoutFallbackToVault`) and it retrieves funds with `withdraw`. |
| 2 | Can a contract read market state on-chain? | **YES.** `markets(bytes32 marketId)` returns the full struct: `oracleQuestionId, outcomeSlotCount, voidPolicy, collateral, originOperatorId, originVenueId, oracleAdapter, creator, market, pool, yesId, noId, tradingStart, expiry`. Best bid/ask still comes from the book, not this view. |
| 3 | **Can Abadi receive a reactivity callback?** | **YES, but not through OracleHub.** The OracleHub callback path is closed: `BinaryMarketsModule` is the only address a market trusts as its settler, and `enableReactivity()` on the hub is owner-gated. **Abadi must own its own subscription against the Somnia reactivity precompile at `0x0100`.** The errors `OnlyReactivityPrecompile` and `NotReactivity` exist precisely so a third-party contract can guard its own callback. |
| 4 | Can a contract call `mintCompleteSet` / `mergeCompleteSet`? | **YES.** Plain external functions on `BinaryMarketsModule`: `mintCompleteSet(uint32 operatorId, bytes32 venueId, bytes32 marketId, uint256 amount)` and the matching merge. `(operatorId, venueId)` are attribution-only and may be 0. |
| 5 | Gas cost per roll? | **Still unknown.** Requires execution. Reactivity subscriptions are funded with native currency and tuned via `setReactivityGasParams(priorityFeePerGas, maxFeePerGas, gasLimit)`. Budget this on Day 1. |
| 6 | Is market creation permissionless? | **NO, by default.** `MarketCreatorPolicy.approved(address)` is an owner-gated allowlist (`setCreator(address,bool)`), and adapter approval on the module is protocol-admin-only with the OracleHub as the single approved adapter. `createVenue` does carry a `creationEnabled` flag and the hub has explicit "open venue" payer-credit handling, so an open venue is a supported mode — but not one we control. **Layer 5 stays cut unless DreamDEX grants creator approval.** |

### The template for the roll — already shipped, and readable

`MarketCreator` (a factory-minted instance) does exactly what ConvictionVault needs, and
its ABI is public:

```
registerSeries(uint32 seriesId, (address collateral, string asset,
               uint64 numericDecimals, uint64 intervalSec, uint64 settlementWindow) s)
triggerRoll(uint32 seriesId)
armFirstRoll(uint32 seriesId, uint256 firesAtSec)   // arm at a future wall-clock boundary
cancelSubscription(uint256 firesAtSec)
setReactivityGasParams(uint64 priorityFeePerGas, uint64 maxFeePerGas, uint64 gasLimit)
receive()                                            // funded with native for roll gas
```

Two things this settles:

1. **Somnia reactivity supports time-based arming, not only event reaction.**
   `armFirstRoll(seriesId, firesAtSec)` schedules against a wall-clock boundary. A
   position roll arms at market expiry the same way.
2. **The venue already rolls the market series this way.** Abadi rolls a *user position*
   rather than a market, but the architecture is identical and proven in production code
   we can read.

The precompile is testnet/mainnet only — it does not exist on local anvil. Fork tests
against Somnia testnet are therefore mandatory; local unit tests cannot cover this path.

### Permissionless keeper entries — confirmed in the ABI

`finalizeMarket(bytes32 marketId)` and `releasePool(bytes32 marketId)` are documented in
the SDK source as "NEW permissionless keeper entries", alongside
`pokeOracle(uint256 oracleQuestionId)`. The bounty-trigger fallback for requoting, and for
Conviction if reactivity funding proves too expensive, rests on real functions.

### Corrections this verification forced

- **Windows are 15-minute and 1-hour, not 5-minute.** BTC and ETH only. Every cadence
  number in an earlier draft was wrong by 3×.
- **Strike is the window's opening price** — at-the-money only, no strike ladder. This
  confirms the decision to cut multi-strike volatility products and build Streak from
  consecutive windows instead.
- **Testnet collateral is tUSDC at 6 decimals** (`0x70a86D…`), and mainnet USDso at 18.
  The 18-decimal USDso seen on `/v0/markets` is the *spot* venue's quote token — a
  different thing. All six core addresses verified byte-for-byte against the raw docs.
- Testnet funding needs no faucet page: `faucet(uint256 amount)` credits `msg.sender`,
  capped at 10,000 tUSDC per call (`FaucetCapExceeded` above that).
- Symbols look like `BTC-0-12AUG26-1600/USDso#YES`.
- SDK floor is real and has two steps: below 0.23.0 nothing reads at all (the indexer
  dropped the `longOpenInterest` column those versions still request); below 0.28.0
  float prices land off the tick grid. Current version is **0.28.1**.
- The SDK ships its ABIs — `binaryModuleReadAbi`, `binaryModuleWriteAbi`,
  `binarySettlementAbi`, `erc6909Abi`, `oracleHubAbi`, `marketCreatorAbi` — so the
  Solidity side can be written against real signatures rather than guesses.

### What remains genuinely unverified

Everything above is read from source and live endpoints. **Nothing has been executed.**
Still open until a transaction runs on testnet:

- Gas cost of a roll, and whether per-user or per-bucket rolls are affordable
- Whether a third-party contract's own `0x0100` subscription behaves as the
  `MarketCreator` usage implies
- Actual parity deviation frequency and size on the live book — the entire premise of
  LiquidityVault's spread capture
- Whether resting liquidity exists at all right now on the testnet event-contract books

---

## 19. Build order

Ordered so that each stage leaves a demonstrable product, and cutting from the bottom
never leaves anything half-finished.

| Day | Work | Ships |
|---|---|---|
| 1 | Execute the two open spikes on testnet: `faucet()`, deploy a probe contract, arm a `0x0100` subscription, measure roll gas, snapshot live book depth and parity spread | Go/no-go on reactive rolls and on Liquidity's premise |
| 2–4 | **MarketEngine** + Foundry tests | Shared foundation |
| 5–6 | **ConvictionVault** + SettlementHook (reactive roll) | The headline product works |
| 7 | **StreakVault** | Near-free given the roll engine; best demo footage |
| 8–9 | **PWA** — Conviction + Streak + portfolio, session keys | A product a stranger can use |
| 10 | **LiquidityVault** — zero-inventory two-sided quoting inside the 2.9% incumbent spread | Second vault, real volume on the venue |
| 11 | **AbadiDelegate (7702)** *or* **Telegram Mini App** — whichever is stronger by then | Power-user or distribution |
| 12 | **MCP server** + Liquidity UI + polish | Agent surface |
| 13 | **Demo video, README, deck, SDK feedback report** | All submission deliverables |
| 14 | Buffer + submit | — |

**Deferred beyond the hackathon, by explicit decision:** TrancheRouter (Layer 3),
Open Questions (Layer 5, unless spike #6 clears), social/copy-trading (Layer 9), token
(Layer 14). All are designed above and appear in the deck as roadmap with interfaces
specified — which is stronger evidence of thinking than a half-built version would be.

**Honest note on scope:** everything in this document is roughly five to six weeks of
work. The fourteen-day plan above ships Layers 0, 1, 2, 4, 6, 7, and 8. The cut is
deliberate and stated rather than discovered by running out of time.

---

## 20. Risks

| Risk | Mitigation |
|---|---|
| A third-party `0x0100` subscription does not behave as `MarketCreator`'s usage implies | Fall back to permissionless bounty rolls via the confirmed keeper entries (`finalizeMarket`, `releasePool`, `pokeOracle`). Still trustless and non-custodial; the pitch shifts from "no keeper" to "no *trusted* keeper", leaning on zero fees and atomic execution. Decided Day 1. |
| Reactivity gas per roll is too expensive to fund | Coarsen buckets so one subscription serves many users, or arm reactivity only for large positions and bounty-roll the rest. Measured Day 1, not discovered Day 10. |
| No resting liquidity on the testnet books | Both vaults assume a book exists. If it is empty, Abadi must seed it — which is the zero-inventory mint-a-pair quote from the original liquidity thesis. Fold that in rather than cut it. |
| Conviction decay makes users lose money | Fan chart shown before deposit, conviction level capped, auto-exit floor. Disclosed, never hidden. |
| Liquidity finds no deviations | Thin new venue makes deviations more likely, not less. If genuinely absent, that is itself a finding worth reporting — and Conviction carries the submission. |
| Testnet instability during demo | Record the video on Day 12, not Day 14. |
| SDK version bugs | Pin `@somnia-chain/markets-sdk@^0.28.0`. Earlier versions carry known pricing and indexing bugs. |
| Venue ID changes | Verified at startup against live market data, with a clear failure message. Docs warn these shift frequently. |
| Scope overrun | Build order above is strictly prioritised. Cutting from the bottom always leaves a complete product. |
| Judged as "too complex to evaluate" | The video leads with one product — Conviction — and one sentence. Everything else is depth behind it, not competing headlines. |

---

## Appendix — why this wins on the published rubric

| Criterion | Weight | Where Abadi scores |
|---|---|---|
| Technical Implementation | 25% | Contracts calling a live CLOB, reactive settlement callbacks, atomic two-leg execution, thirteen sharp edges handled explicitly |
| Innovation & Originality | 20% | Persistence exposure is a new instrument class. Parity harvest is only viable at zero fees. Neither exists in the Somnia ecosystem. |
| User Experience & Design | 20% | One tap, session keys, auto-claim, honest payoff disclosure before deposit |
| Business & Ecosystem Impact | 20% | Generates trading activity directly — the rubric's own words. Tightens spreads for every other DreamDEX user. Fills the empty prediction-market slot in Somnia's 2026 roadmap. |
| Presentation & Demo | 15% | One legible problem, one visceral demo shot: deposited once, rolled twenty-four times, untouched |

**The differentiator:** Abadi is the only submission that makes DreamDEX better rather
than merely using it.
