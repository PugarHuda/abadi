# Abadi

**Liquidity for DreamDEX Event Contracts.**

*Abadi* is Indonesian for **everlasting** — the markets expire every window, the
liquidity does not.

Built for the Somnia × DreamDEX Event Contracts Hackathon.

**[abadi-wheat.vercel.app](https://abadi-wheat.vercel.app)** ·
[The working](https://abadi-wheat.vercel.app/dashboard) ·
[Deck](https://abadi-wheat.vercel.app/deck) ·
[Vault on the explorer](https://shannon-explorer.somnia.network/address/0xEF66Fa6Ae6AE0022f1A7524B90D49B293f9D1C10)

---

## What it is

A market-making vault that quotes both sides of DreamDEX Event Contract markets with
**zero inventory**, and captures the spread with **no directional exposure**.

Depositors put in collateral and receive ERC-4626 shares. An operator key steers quotes
and can never touch the money. Every filled pair is worth exactly 1 at settlement no
matter which way the market resolves.

**Live on Shannon testnet:** `0xEF66Fa6Ae6AE0022f1A7524B90D49B293f9D1C10`
(`node scripts/attest.ts` checks that address is running this source — see below for
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
| `governor` | set operator, risk params, grid | touch assets |
| depositor | deposit, withdraw against shares | steer quotes |

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

scripts/                  read-only probes that produced docs/evidence/
  probe.ts                live markets, tiers, spreads
  history.ts              settled-market calibration
  operator.ts             reads the book and quotes inside it, in one pass
  verify.ts               reads our own orders back off the book
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
forge test                 # 73 tests, no network needed

node scripts/probe.ts      # live markets and spreads
node scripts/history.ts    # settled-market calibration
node scripts/operator.ts   # read the book and quote inside it  (needs .env)
node scripts/verify.ts     # read our orders back off the book
node scripts/attest.ts     # is the live address running this source? (needs forge build)
node scripts/ledger.ts     # every episode the vaults have run, marked from chain events
node scripts/bot.ts        # the requote loop  (CYCLES=3 INTERVAL=30 SHORTEST=1 to try it)
```

`.env` needs `PRIVATE_KEY` for anything that writes. Deploy:

```bash
forge create src/LiquidityVault.sol:LiquidityVault \
  --constructor-args $COLLATERAL $MODULE $OUTCOME_TOKEN $GOVERNOR 1000 1000
```

`1000 / 1000` are the tick and lot grids: `precision.price = 3` on this venue, which is
`0.001` at the collateral's 6 decimals.

---

## Honest status

**Run against the venue, on Shannon**

- Quoting inside the incumbent's spread, top of book, both legs filling into complete sets
- `settle()` and `flatten()`, each several times — seven complete-set episodes so far,
  **+17.00 tUSDC on 683.00 of basis (2.49%)**, every one read back off the chain by
  `scripts/ledger.ts` rather than remembered
- **The vault wakes itself up.** A 900s window was quoted, expired, resolved, and the
  reactivity precompile called the vault at the armed second; the vault redeemed its own
  position and freed the slot with nobody calling it. Tx `0x66c0e1ec…`, block 472752861.
  The first attempt ran out of gas at the hard-coded 500k; the limit is now sized from a
  measurement, and the callback's 60 ms of jitter is handled.
  [`docs/evidence/reactivity-live-2026-08-27.md`](docs/evidence/reactivity-live-2026-08-27.md)
- `scripts/bot.ts` — the requote loop: settles what resolved, finalizes what expired
  through the venue's permissionless keeper entry, flattens a dead quote's complete set,
  quotes into idle slots, and arms a wake-up at each window's expiry so the chain closes
  the position even if the bot is down
- The site reads the vault live in the visitor's browser — four `eth_call`s to the public
  RPC, no server of ours, and an explicit failure state rather than a stale number
- 73 tests passing, including two fuzzed invariants; axe-core WCAG 2.1 AA on every page in
  CI; `scripts/attest.ts` says the live address is running this source

**What it cost to get here**

Seven deployments in two days, each one a fix the previous one lacked, all listed in
`scripts/ledger.ts` with the reason. Written off along the way, all testnet:

| where | how much | why |
|---|---|---|
| v1 `0xbcc310b2…` | 97.40 | build predated `settle()`; no exit exists |
| v2 `0xbCAe987E…` slot 1 | 43.80 + 53.60 resting | one-sided fill on a build whose exits all reverted |
| v5 `0x98954577…` | 102.13 | the last share was redeemed before the slot settled; ERC-4626 hands the proceeds to the virtual share and a re-seed lost more to rounding than it retrieved |

The last one is now impossible by construction: `LastShareWhileOpen` refuses to let the
final share out while any slot is active. The other two are why `scripts/attest.ts` and
the mock pool that reverts like the real one exist.

**Not done**

- Source verification on the Shannon explorer. Both the Etherscan-style route and the
  Blockscout v2 standard-input route accept the submission and then report
  `Unable to verify`; the verifier lists `osaka` as supported, which is what this was
  compiled for. `scripts/attest.ts` compares the deployed bytecode to the artifact
  directly, which is the stronger check, but a judge who clicks the address still sees
  bytecode.
- A track record. Seven complete sets is a mechanism working, not an edge. The ledger
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
