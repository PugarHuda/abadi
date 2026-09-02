# Abadi

**Liquidity for DreamDEX Event Contracts.**

*Abadi* is Indonesian for **everlasting** — the markets expire every window, the
liquidity does not.

Built for the Somnia × DreamDEX Event Contracts Hackathon.

**[abadi-wheat.vercel.app](https://abadi-wheat.vercel.app)** ·
**[App](https://abadi-wheat.vercel.app/app)** ·
[The working](https://abadi-wheat.vercel.app/dashboard) ·
[Deck](https://abadi-wheat.vercel.app/deck) ·
[Vault on the explorer](https://shannon-explorer.somnia.network/address/0xFd9c93581ADD42B9B13ba5550542Fc7315775cD9)

---

## What it is

A market-making vault that quotes both sides of DreamDEX Event Contract markets with
**zero inventory**, and captures the spread with **no directional exposure**.

Depositors put in collateral and receive ERC-4626 shares. An operator key steers quotes
and can never touch the money. Every filled pair is worth exactly 1 at settlement no
matter which way the market resolves.

**Live on Shannon testnet:** `0xFd9c93581ADD42B9B13ba5550542Fc7315775cD9`
([source on the explorer](https://shannon-explorer.somnia.network/address/0xFd9c93581ADD42B9B13ba5550542Fc7315775cD9?tab=contract) ·
`node scripts/attest.ts` checks that address is running this source — see below for
why that is a thing we check now)

---

## Why quoting, and not predicting

We did not pick this from a whiteboard. We measured it.

**2,422 settled markets, pulled from the indexer:**

| Tier | n | UP won | z vs a fair coin |
|---|---|---|---|
| 60s | 500 | 49.6% | −0.18 |
| 300s | 500 | 48.6% | −0.63 |
| 900s | 500 | 48.2% | −0.80 |
| 1h | 500 | 51.0% | +0.45 |
| 4h | 364 | 51.9% | +0.73 |
| 24h | 58 | 58.6% | +1.31 |
| **pooled** | **2422** | **49.96%** | **−0.04** |

Outcomes are indistinguishable from a coin flip. Meanwhile the venue quotes a flat
**2.9% spread** on every market and every tier.

With a coin flip and a 2.9% spread, the arithmetic is not ambiguous:

```
taker (crosses the spread)   -1.45% per contract
maker (collects the spread)  +1.45% per fill
```

Our original design had a directional vault **taking** liquidity each window. On the
900-second tier at 10% deployment that is:

```
after 1 day  ( 96 rolls)  ->  87.0% of deposit
after 7 days (672 rolls)  ->  37.7%
```

Zero fees do not save it — the spread is the cost. **We cut that product on the evidence
and built the other side of the trade instead.** Full working in
[`docs/evidence/calibration-2026-08-26.md`](docs/evidence/calibration-2026-08-26.md).

---

## The mechanism

DreamDEX keeps **one** order book. A Buy YES crossing a Buy NO needs no seller at all —
the pool mints a fresh YES/NO pair from the two buyers' combined collateral.

That is what makes zero inventory possible:

```
BUY_YES @ p         escrows  p          per contract
BUY_NO  @ p + s     escrows  1-(p+s)    per contract   (price is always YES-side)
                             -------
pair cost                    1 - s
```

Both legs fill → the vault holds a complete set, worth exactly **1** at settlement
whichever side wins. The spread `s` is captured with **zero** directional exposure, and
no inventory was needed up front.

Verified on chain: 100 contracts a side escrowed **97.40 tUSDC**, not 100.

### Custody

BinaryPool has no operator gate — the DreamDEX team confirmed that the only shape that
works today is a contract that owns its own orders. That is exactly what Abadi is.

| Actor | Can | Cannot |
|---|---|---|
| `operator` (bot key) | quote, cancel | **move a single token** |
| `governor` | set operator, risk params, grid; `sweepNative` the vault's native STT | **touch depositor collateral** |
| depositor | deposit, withdraw against shares | steer quotes |

`sweepNative(address,uint256)` moves the vault's entire native balance anywhere the
governor names — today ~32.8 STT, and that is the same reserve the vault spends to wake
itself up. Depositor collateral is reachable from no governor entry point at all.

---

## What is live

First quote on Shannon, `ETH-0-27AUG26/tUSDC`:

```
theirs : 0.742 / 0.772    spread 0.030
ours   : 0.744 / 0.770    spread 0.026   <- inside
```

Read back off the live book:

```
       BIDS                   ASKS
  0.744  x 100  <- Abadi      0.769  x 200
  0.742  x 200                0.770  x 100  <- Abadi
  0.733  x 330                0.779  x 330
```

Abadi's bid became the **best bid on the market**, and the spread went from **0.030 to
0.025** — the incumbent quoter tightened in response.

That is the ecosystem-impact claim demonstrated instead of asserted: one vault quoting
inside made prices better for everyone else trading that market.

tx [`0x3a8b93bb…`](https://shannon-explorer.somnia.network/tx/0x3a8b93bba2a39a35102d44f8005143dafb9317033003befec7b4c5fbe095a6dd)

### Then both legs filled

ETH moved, the market's implied probability fell from about 0.75 to 0.50, and both of our
resting legs were taken. On-chain holdings:

```
paid at quote time         97.40 tUSDC
holds                      100 up  +  100 down     <- a complete set
worth at settlement        100.00 tUSDC            <- whichever side wins
                          ----------------
locked in                   +2.60 tUSDC  ·  2.67%
directional exposure         0.00
```

Both legs were **buys**. Neither could have filled against a seller, because no seller
was involved — they crossed each other through the mint-a-pair path and the pool minted
the pair. That is why the position cost 97.40 rather than 100, and why it needed no
inventory to begin with.

Zero-inventory two-sided quoting is not a design claim any more. It happened.

**One fill is not a track record.** It proves the mechanism; it says nothing yet about
fill frequency or adverse selection, which is the real risk a maker carries. Measuring
that needs many quotes over many windows.
[`docs/evidence/first-fill-2026-08-26.md`](docs/evidence/first-fill-2026-08-26.md)

---

## Architecture

```
src/
  MarketEngine.sol        pure grid math — every SDK sharp edge paid for once
  LiquidityVault.sol      ERC-4626 vault, zero-inventory two-sided quoting
  AbadiReactive.sol       keeper-free wake-up via the reactivity precompile
  interfaces/
    IBinaryPool.sol            placeBinaryOrder, ORDER_KIND, ERC-6909 outcomes
    IBinaryMarketsModule.sol   markets(), mint/merge, redeem, keeper entries

scripts/                  the chain scripts that produced docs/evidence/
  probe.ts                live markets, tiers, spreads
  history.ts              settled-market calibration
  operator.ts             reads the book and quotes inside it, in one pass
  verify.ts               reads our own orders back off the book
  backtest.ts             replays the fair-value model over resolved windows and scores it
  impact.ts               rebuilds every window's book with and without Abadi's orders
  recover.ts              walks the deployer's CREATE nonces for anything left in a vault
```

### Lifecycle

```
quote ──► fill ──┬──► flatten ──► collateral back immediately
                 └──► settle  ──► redeem after resolution
```

**`settle()` is permissionless.** Proceeds go to the vault, never the caller, so there is
nothing to steal — and a settled market leaves the live list entirely, so nothing
upstream will remind the vault the position exists. Redemption has to be pulled, and
gating it behind a key is how capital gets stranded when that key goes quiet.

**`flatten()` merges complete sets back to collateral without waiting.** A complete set is
worth exactly 1 at any moment, so leaving it idle until the window resolves wastes the
capital.

Its access is split rather than open, deliberately. Cancelling a live quote throws away
the spread the vault exists to earn, so a fully open `flatten` would let anyone grief the
vault by closing good quotes on repeat. The operator may flatten whenever it judges a
quote dead; **anyone** may flatten once the market can no longer trade, because past that
point no fill is possible and capital must not sit behind a key that has gone quiet.

An uneven fill leaves a single-side leg that cannot be merged and still carries
direction — `flatten` merges what it can and leaves the slot open for `settle()`.

---

## Running it

```bash
npm install
forge install foundry-rs/forge-std   # forge-std is not vendored
forge test                 # 115 tests, no network needed

node scripts/probe.ts      # live markets and spreads
node scripts/history.ts    # settled-market calibration
node scripts/operator.ts   # read the book and quote inside it  (needs .env)
node scripts/verify.ts     # read our orders back off the book
node scripts/attest.ts     # is the live address running this source? (needs forge build)
node scripts/backtest.ts   # score the fair-value model against resolved windows
node scripts/impact.ts     # the venue's spread with Abadi in the book, and without
node scripts/recover.ts    # what every vault this deployer made still holds
node scripts/ledger.ts     # every episode the vaults have run, marked from chain events
node scripts/bot.ts        # the requote loop  (CYCLES=3 INTERVAL=30 SHORTEST=1 ACTIVE=3 SIZE=100)
node scripts/fork-test.ts  # the vault against the real pool and module, on a fork of Shannon
```

`.env` needs `PRIVATE_KEY` for anything that writes. Deploy:

```bash
forge create src/LiquidityVault.sol:LiquidityVault \
  --constructor-args $COLLATERAL $MODULE $OUTCOME_TOKEN $GOVERNOR 1000 1000
```

`1000 / 1000` are the tick and lot grids: `precision.price = 3` on this venue, which is
`0.001` at the collateral's 6 decimals.

The keeper runs from GitHub (cron, off the quarter-hour marks GitHub drops under load)
and from the operator's machine (`scripts/keeper.cmd`, Windows Task Scheduler, every
fifteen minutes) — whichever fires first does the work; the second finds the slots
busy. GitHub fired zero scheduled runs in the repository's first nine hours, which is why
the second exists.

To let the vault wake itself, send it **32 STT** (`cast send $VAULT --value 32ether`):
the reactivity precompile refuses a subscription from a handler holding less, and the
bot skips arming and says so until then. `sweepNative` brings the reserve back out.

---

## Honest status

**Run against the venue, on Shannon**

- Quoting inside the incumbent's spread, top of book, both legs filling into complete sets
- **The vault is down, and the number that says so is the one to read.** The vault
  running today was deployed on 2026-08-31 and its share price is **1.000000**, because a
  new ERC-4626 starts at par. **That is not a return; it is a new contract.** The record
  the price forgot is the one to read: across 95 episodes on 10 vaults, 72 closed into a
  complete set, 18 one-sided, 1 with neither leg filled, and **−217.90 realised on
  8,280.95 of basis**. The vault it replaced ended at per share **0.951368** against
  shares issued at par — **−6.84%** at its worst reading on the 31st, for anyone who had
  deposited. `scripts/ledger.ts` reads every figure back off the chain across all ten
  addresses, so the redeploy does not clear the history; it only resets the denominator
  of one of them.

  This replaces "+133.85 on 5,641.15 of basis (2.37%)", which this file carried until
  2026-08-31. That figure was not invented: it was the realised spread on the winning
  episodes. But the ledger accumulated profit and basis *only* in the complete-set
  branch, so the 18 one-sided episodes entered neither the numerator nor the denominator,
  and the published return was arithmetically incapable of going negative. The dashboard
  ran the same code, so its equity curve could not draw a drawdown either. Both are fixed;
  the sign of the answer changed.
- The record is not uniform by window length, and that is where the loss lives: a
  complete set earns about 2.19 and an adverse fill costs about 22, so the strategy needs
  an adverse rate under roughly 9% and is running at 20%. The 4h tier is the only one
  measurably above water
- **The vault wakes itself up.** A 900s window was quoted, expired, resolved, and the
  reactivity precompile called the vault at the armed second; the vault redeemed its own
  position and freed the slot with nobody calling it. Tx `0x66c0e1ec…`, block 472752861.
  The first attempt ran out of gas at the hard-coded 500k; the limit is now sized from a
  measurement, and the callback's 60 ms of jitter is handled. A second wake-up, armed by
  the bot rather than by hand, closed a naked leg that lost — the shape the old `settle`
  refused forever — at block 473130786.
  [`docs/evidence/reactivity-live-2026-08-27.md`](docs/evidence/reactivity-live-2026-08-27.md)
- **And where it did not.** The same sweep was a no-op on the shape it most needed to
  handle. A pool freezes its entire order book from the instant a window expires until
  that market is terminal — every cancel the venue offers, including the two documented
  as permissionless drains, answers one undecodable error — so the two cancels `_release`
  opened with always reverted and took the whole slot's callback down with them. Two
  windows whose oracle never answered held 196.00 of escrow for two days behind that.
  The way out was the market's own `voidExpired()`, permissionless and open 300 seconds
  after expiry, which recovered **208.90 on 196.00 of basis** on the 30th. The vault now
  takes that hatch itself — void, sync, finalize, settle — and `flatten`'s promise that
  *anyone* may call it once a market cannot trade, which the same freeze had made empty,
  holds again. Proven against the real pool on a fork, and **live since 2026-08-31**:
  the vault at `0x2c960227…` is the first deployment that carries it.
  [`docs/evidence/dead-oracle-2026-08-30.md`](docs/evidence/dead-oracle-2026-08-30.md)
- `scripts/bot.ts` — the requote loop, three markets at a time, with a **momentum filter**:
  up to eight candidates' books are read twice, twenty seconds apart, and a window whose
  mid moved three ticks in between is not quoted — every adverse fill in the ledger came from a
  trending hour, and one adverse fill costs what twenty complete sets earn. Size halves
  on the 900s tier, windows priced under 0.08 or over 0.92 are left alone — the only
  thing that can happen to the expensive leg there is the tail event — and the 24h tier
  is not quoted at all: `scripts/ledger.ts` now breaks the record down by window length,
  and 15m and 4h windows run far cleaner than 1h and 24h. It settles what resolved,
  pokes the oracle on what expired and voids it through the market's own escape hatch once
  the oracle is out of time, pulls and
  requotes an unfilled quote the book has walked away from, flattens a completed one,
  quotes into idle slots, and arms a wake-up past each window's settlement deadline so the
  chain closes the position even if the bot is down. First wide run: three complete sets flattened in
  one cycle, one of them from a requote
- **The book is measurably tighter because Abadi is in it.** Every window this project
  has quoted was rebuilt twice from the venue's own order rows — once with Abadi's orders
  and once with them removed — at the instant our quote landed. Across **70 windows** the
  spread was **0.0249 without us and 0.0192 with us: 5.8 ticks tighter, 23% narrower.**
  It tightened on **66 of 70**, was unchanged on 4, and widened on none. Nothing here is
  modelled or self-reported; which orders are ours is decided by the `owner` field the
  venue itself writes. `node scripts/impact.ts` ·
  [`docs/evidence/impact-2026-08-31.txt`](docs/evidence/impact-2026-08-31.txt)
- **A one-sided fill is now closed, not carried, and two days of it are measured.** One
  leg fills, the book leaves, and the vault holds a direction worth 1 or 0 at settlement.
  `completeSet` crosses the book for the missing side with an IOC order, so the pair
  becomes worth exactly 1 and the loss is the spread instead of the leg. Across every
  one-sided fill this project has taken:

  | | episodes | mean result | worst |
  |---|---|---|---|
  | carried to settlement | 18 | **−25.98%** of basis | −100.00% |
  | completed | 6 | **−3.98%** | −6.00% |

  Twenty-two points per adverse episode, and completing cannot produce a −100 because a
  pair is worth exactly one either way. It **refused 34 times against those 6** — at
  1.239, 1.416, 1.490, 1.562 the pair, where booking a certain loss to avoid a coin flip
  is worse than the coin flip. Proven against the real pool in
  `test_fork_completeSetClosesANakedLegOnTheRealPool`.
  [`docs/evidence/two-days-of-completing-2026-09-02.md`](docs/evidence/two-days-of-completing-2026-09-02.md)
- **The ledger flattered itself again, and its own check caught it.** With completions
  landing, realised read **+335.00** where it had read −196.40 — because an episode's cost
  came from the `Quoted` event alone and `completeSet` spends collateral no `Quoted` knows
  about. Six of them inflated the number by **538.20**. The reconciliation written in after
  August's audit is what surfaced it: realised said +525.30 on the live vault while the
  share price said −12.90, and a gap that size with one position open is a wrong number,
  not slack. Both ledgers read `SetCompleted` now. Second time a new feature has flattered
  this project's P&L; second time the share price was the thing that could not be fooled.
- **`reduceQuote` trims a resting quote in place — and has not fired once in 1,262
  cycles.** It is wired, tested, and proven on the real pool, and the logs say why it never
  triggers: this book moves 29, 33, 49 ticks between two samples twenty seconds apart, so
  a quote is either still where the market is or completely stale. There is no drifting
  middle for a three-tick trim band to catch. The knob is not being widened to force a
  firing; `reduceOrder`'s queue-priority argument needs a loop that resamples in seconds. Cancel-and-replace surrenders
  price-time priority; `reduceOrder` does not, and the SDK has shipped it the whole time
  with no path from an operator key to reach it. The venue's own docs warn an id can be
  "replaced by a reduce", so the contract reads the leg back and reverts unless the same
  id is still resting at the new size. **On the real pool the id survives** —
  `test_fork_reduceQuoteKeepsTheOrderIdOnTheRealPool`.
- **The settle sandwich is closed with time, not a block.** A naked leg marks at zero, so
  a winning one on a resolved market is value NAV does not show, and `settle` is
  permissionless. The old one-block guard could not close the patient version, and said so
  in its own comment — on sub-second blocks a block is a formality. `redeemDelay` is 300s,
  the venue's settlement window, capped at one hour so governance can tune it and cannot
  freeze the vault with it.
- **The vault prices the windows itself, and a backtest says that buys less than it
  sounds like.** `scripts/lib/fairvalue.ts` computes the digital's closed form, N(d₂),
  from the venue's own price-feed plane — spot and strike off the tick tape, σ from M1
  candles with a half-life matched to the window's own length. `scripts/backtest.ts` then
  replays it against **1,276 finalised windows**, scoring it at each market's last trade
  from data that existed at that instant. Brier **0.1698 for the model against 0.1703 for
  the book**: a tie, and both well clear of a coin flip's 0.25. It is properly calibrated
  — say 0.958, and 97.7% pay — but where the two disagree by 0.10 or more **the book wins
  on both sides**, by 0.178 against 0.041 above and 0.111 against 0.066 below. The
  suspected cause was an over-large σ; rescaling it from 0.5× to 1.5× moves Brier by 0.001
  and the optimum is 1.0×, so that hypothesis is tested and rejected. What the model earns
  is the **refusal**: the bot will not quote a window it disagrees with the book about by
  more than 0.10, and the backtest is why that rule is kept and why its stated reason
  changed. [`docs/evidence/backtest-2026-08-31.md`](docs/evidence/backtest-2026-08-31.md)
- **Five stateful invariants**, fuzzed across thousands of random interleavings of
  deposit, quote, fill, cancel, flatten, resolve, settle and withdraw: NAV is exactly cash
  plus resting plus complete sets, the vault's derived escrow equals what the pool's own
  ledger holds, shares never overstate assets. The first run found a real defect — two
  slots on one window shared the same outcome balances — now refused by construction
- **The vault against the real venue, on a fork.** `test/fork/Venue.fork.t.sol` forks
  Shannon, deploys the vault, quotes a live window, then plays the taker — crossing the
  vault's own legs through the real BinaryPool so the real module mints the pair and
  merges it. Four tests, no mock anywhere; the shape of every defect the mock pool hid.
  Runs every six hours on GitHub and on demand with `node scripts/fork-test.ts`
- **An app.** `/app` connects the wallet the visitor already has (EIP-1193), switches it
  to Shannon or adds the chain, mints test collateral from the venue's faucet, and
  deposits into or redeems from the vault. No wallet library, no ABI library: every call
  is a selector and 32-byte words built in `web/app.js`, and the browser suite compares
  what the page sends with the encoding written out by hand, byte for byte. The guard
  the contract enforces (`LastShareWhileOpen`) is explained before the button is pressed,
  not after it reverts
- The site reads the vault live in the visitor's browser — five `eth_call`s to the public
  RPC plus one per slot, fourteen requests at the widest, no server of ours, and an
  explicit failure state rather than a stale number. The dashboard also renders the whole
  track record from the explorer's log API, decoded in
  the browser against the vault's ABI — as a table, as one cumulative line with a
  crosshair readout, and as a heartbeat ("last activity 12 min ago") that would be the
  first thing to change if a keeper died — so the numbers above can be checked without
  trusting this file
- 115 unit tests including two fuzzed properties and five stateful invariants, 9 fork tests against the venue, 77
  browser tests (axe-core WCAG 2.1 AA, Core Web Vitals, touch, the transactions cited on
  the landing page checked against the explorer); `scripts/attest.ts` compares the live
  address against this source and reports **MATCH**, and the address it names is verified
  on the explorer. Coverage on the contracts, measured with
  `forge coverage --ir-minimum`: **`LiquidityVault.sol` 97.25% of lines and 100% of its 43
  functions**, `MarketEngine.sol` 100% of lines
- The site passes [Impeccable](https://impeccable.style)'s 59-rule design detector on
  every rendered page, desktop and mobile, as a CI gate. Its first run found the
  defaults AI-built interfaces reach for — 10px tracked-caps labels, eyebrows above
  headings, monospace as a costume, transitions on `width`, teal text reading as neon
  — and they are gone. Product truth lives in `PRODUCT.md`; waivers with reasons in
  `.impeccable/config.json`

**What it cost to get here**

Nine vaults between 26 and 30 August, each one a fix the previous one lacked: eight
retired, listed in `scripts/lib/vaults.json` with the reason, plus the live one deployed
on the 31st. The same key also deployed `0x5e6b9242Db15959EdCEccBa5C369fca3576fd598` at
nonce 8, which was recorded in no file here and held **5,000.00 tUSDC** unnoticed for five
days; `scripts/recover.ts` walks the deployer's CREATE nonces instead of the list and
found it, and it is back. Written off along the way, all testnet:

| where | how much | why |
|---|---|---|
| v1 `0xbcc310b2…` | 97.40 | build predated `settle()`; no exit exists |
| v2 `0xbCAe987E…` slot 1 | 43.80 + 53.60 resting | one-sided fill on a build whose exits all reverted |
| v5 `0x98954577…` | 102.13 | the last share was redeemed before the slot settled; ERC-4626 hands the proceeds to the virtual share and a re-seed lost more to rounding than it retrieved |

The last one is now impossible by construction: `LastShareWhileOpen` refuses to let the
final share out while any slot is active. Two more defects were found on the 28th without
losing anything: the invariant fuzzer showed two slots on one window sharing outcome
balances (now `MarketAlreadyQuoted`), and `verify.ts` showed 200 tokens under a
100-contract slot because `cancelQuote` had swallowed a real cancel failure from the pool
and freed a slot whose legs were still live (now `CancelFailed`; only the pool's own
"already gone" answer is tolerated). The other two are why `scripts/attest.ts` and
the mock pool that reverts like the real one exist.

**Verified source on the explorer**, after two days of `Unable to verify`. The verifier
lists `osaka` — forge's default target for 0.8.30 — and cannot reproduce it; a nine-line
probe verified on `cancun` and failed on `osaka` from the same toolchain. `foundry.toml`
now pins `cancun`, and the live address shows source rather than bytecode.
[`docs/evidence/verification-2026-08-28.md`](docs/evidence/verification-2026-08-28.md)

**Not done**

- A track record. What the ledger holds is a mechanism working, not an edge. The ledger
  script exists so the number can grow without anyone having to trust it.

---

## What the evidence folder is for

Every number in this README is reproducible from recorded output, not from a model:

| File | What it shows |
|---|---|
| `probe-2026-08-26.txt` | live markets, six tiers, the flat 2.9% spread |
| `calibration-2026-08-26.md` | 2,422 settled markets and the maker/taker arithmetic |
| `live-quote-2026-08-26.md` | the working quote, and the calldata diff that found the price-scale bug |
| `first-fill-2026-08-26.md` | both legs filled, and what the position is actually worth |
| `reactivity-spike-2026-08-26.md` | a full day of wrong hypotheses, and the resolution |

Four of our assumptions were killed by running things rather than reading about them:
5-minute windows (there are six tiers), parity arbitrage (impossible — one book),
the reactivity callback path (closed), and the price scale (collateral decimals, not
1e18). None of those were visible from the documentation.

[`docs/SDK-FEEDBACK.md`](docs/SDK-FEEDBACK.md) reports each of them back to the DreamDEX
team, with reproduction steps.

---

## License

MIT
