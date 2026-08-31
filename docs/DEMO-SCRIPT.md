# Demo video — shot list and script

Target **2:45**. The submission allows 2–3 minutes; 15 seconds of headroom means you never
have to rush the ending, which is where the last impression forms.

**Rewritten 2026-08-31.** The previous version was written to the state of the 27th and
led with the trading thesis — "we collect the venue's 2.9% spread". That claim did not
survive being measured. This version leads with what did.

**Record on the 8th at the latest.** Testnet is intermittent: the indexer returns
`fetch failed` roughly one call in five. A failed take is a retry, not a crisis, provided
you are not recording the night before the deadline.

## What to have open before you start

1. `https://abadi-wheat.vercel.app/dashboard`, full screen, scrolled to top
2. A terminal in the repo, cleared, ready for `forge test`
3. The Shannon explorer on the vault, `0xFd9c93581ADD42B9B13ba5550542Fc7315775cD9`
4. `docs/SDK-FEEDBACK.md` in an editor
5. `docs/evidence/ledger-2026-08-31.md` in a second tab, scrolled to the Summary

Turn off notifications. 1080p minimum. Speak slower than feels natural — this is about 390
words, which is a comfortable 2:45 with pauses.

---

## 0:00 — 0:18 · The problem

**Screen:** dashboard, top of page. The wordmark and the thesis line.

> Every prediction market on DreamDEX expires. Sixty seconds, fifteen minutes, a day —
> twelve series running at once, and every one of them dies and respawns.
>
> Liquidity that has to be rebuilt every window isn't liquidity. So we built a vault that
> outlives the markets it quotes.

*Hold on the thesis line for a beat before scrolling.*

---

## 0:18 — 0:50 · The part that is actually hard

**Screen:** the custody table on the dashboard, then cut to `src/LiquidityVault.sol`,
scrolled to `quote`.

> Here's the problem nobody warns you about. BinaryPool has no operator gate — if you give
> a bot a key that can trade, that key can also withdraw. Every market-making vault on this
> venue has to solve that before it can quote once.
>
> Ours solves it by owning its own orders. The vault holds the collateral and places the
> orders itself. The operator key chooses a price and a size and can do nothing else — it
> cannot move a token, and there is no function that would let it.

*Cut to the terminal.*

> Eighty-seven tests. And the caps are on chain, not in a config file on my laptop.

**Run:** `forge test` — let the green line land on screen.

---

## 0:50 — 1:22 · The chain closes the position

**Screen:** the explorer, on transaction
`0x2f75001ea73bd66cf62649841542a2d8b74cad22afa1513e5e6463730a009f50`.

> This is the part I'd want you to remember. A window expired at seventeen hundred UTC. No
> bot ran. Nobody called anything.
>
> Somnia's reactivity precompile woke the vault at the second it was armed for, and the
> vault settled its own position — `CallbackFired`, `Settled`, `Swept`. From the chain,
> for the chain, with the operator key sitting idle.

*Point at the three events in the log list.*

> That took nine deployments to get right. The first one ran out of gas at five hundred
> thousand. It's in the evidence folder, including the ones that failed.

---

## 1:22 — 1:58 · What happened when we measured it

**Screen:** `docs/evidence/ledger-2026-08-31.md`, on the Summary block.

> And here's where I'd rather show you the uncomfortable slide than have you find it.
>
> Until yesterday this project published a two-point-three-seven percent return. That number
> was wrong — not invented, worse. The ledger summed the episodes that closed into a
> complete set and silently dropped the ones that went one-sided. It could not produce a
> loss. Neither could the chart.
>
> The real number is per share, read off the chain: **nought point nine three**. Depositors
> are down six point eight percent. The market-making edge is real in theory and smaller
> than adverse selection in practice — twenty percent of our filled quotes went one-sided.

*Hold on the per-share figure.*

> We found that by auditing ourselves and publishing the result. Every competitor here who
> hasn't measured looks better than us right now, and I'd rather be the one with the number.

---

## 1:58 — 2:28 · What we found in the venue

**Screen:** `docs/SDK-FEEDBACK.md`, scrolled through the issue headings.

> Sixteen reproducible defects in DreamDEX and its SDK, each with a transaction hash.
>
> The one that cost us: a pool freezes its entire order book the moment a window expires,
> including the two calls the SDK documents as the permissionless way to get your escrow
> out. Two windows sat frozen for two days with a hundred and ninety-six dollars of ours
> behind them.
>
> The way out was `voidExpired` — permissionless, open five minutes after expiry, and
> documented nowhere near where you'd look. The vault takes that hatch by itself now.

*Beat.*

> And the pools are beacon proxies. Their implementation can change under a live position
> with no address change and no version to pin. That's issue sixteen.

---

## 2:28 — 2:45 · Close

**Screen:** back to the dashboard, live numbers ticking.

> Abadi is a market maker that survives its own markets expiring, a vault that settles
> itself when nobody is watching, and sixteen bug reports for the venue it runs on.
>
> The strategy needs a fair-value model it doesn't have yet — which, conveniently, is what
> Sigma in this same hackathon is building. That's the next commit.
>
> Everything here is on Shannon, and every number is read from the chain.

*End on the live dashboard, not on a slide.*

---

## Facts to keep straight on camera

Get these wrong and a judge who checks will discount everything else.

| Claim | The number |
|---|---|
| Unit tests | 87 at the time of writing — **run `forge test` and say what it prints** |
| Fork tests against the real venue | 5 |
| Browser tests | 64 |
| Deployments | 9 vaults, 26–30 August |
| Per share | 0.931581 as of 2026-08-31 — **re-read it before recording** |
| Depositor P&L | −320.50 tUSDC, −6.84% |
| Episodes | 95 across 9 vaults; 20% of filled quotes adverse |
| Frozen escrow, recovered | 208.90 back on 196.00 of basis |
| SDK issues filed | 16 |
| Cited transactions verified against chain | 44 of 44, gas figures exact |

**Do not say:** "profitable", "the vault earns 2.37%", or any figure from before the 31st.
The old numbers are still in older evidence files by design — they are dated, and the
correction is dated too.

**Do not claim the fixes are live.** `scripts/attest.ts` reports MISMATCH: the audit
repairs are in the source and the deployed vault is the previous build. If you show the
explorer's verified source, say so.

## The question you will get, and the answer

> *"Your operator key trades. What stops it running off with the money?"*

Cannot transfer, can trade. The vault holds custody and the key cannot reach it — that part
is absolute. What the key can do is quote badly, so the bound on that is on chain too:
`maxQuoteNotional` caps one quote and `maxDeployedBps` caps the whole book as a fraction of
NAV, both governor-set. Before this week that bound was an environment variable on the
machine running the bot, and saying otherwise would have been the wrong answer.
