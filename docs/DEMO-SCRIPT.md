# Demo video — shot list and script

Target **2:45**. The submission allows 2–3 minutes; 15 seconds of headroom means you never
have to rush the ending, which is where the last impression forms.

**Rewritten 2026-09-02.** The version before this was written to the state of the 31st and
led with the drawdown. That was the honest headline then. It is not the headline now: the
vault is above par, the completion is measured, and there is a number about the venue's own
book that no other submission in this hackathon can produce. The close also promoted a
competitor by name — that is gone.

**Record on the 7th at the latest.** Testnet is intermittent: the indexer returns
`fetch failed` roughly one call in five — `scripts/ledger.ts` did exactly that on the 2nd
and the fix is to run it again. A failed take is a retry, not a crisis, provided
you are not recording the night before the deadline.

## What to have open before you start

1. `https://abadi-wheat.vercel.app/dashboard`, full screen, scrolled to top
2. A terminal in the repo, cleared, ready for `forge test`
3. The Shannon explorer on the vault, `0xFd9c93581ADD42B9B13ba5550542Fc7315775cD9`
4. `docs/evidence/impact-2026-08-31.txt` in an editor
5. `docs/evidence/ledger-2026-09-02.md` in a second tab, scrolled to the Summary

Turn off notifications. 1080p minimum. Speak slower than feels natural — this is about 400
words, which is a comfortable 2:45 with pauses.

---

## 0:00 — 0:16 · The problem

**Screen:** dashboard, top of page. The wordmark and the thesis line.

> Every prediction market on DreamDEX expires. Sixty seconds, fifteen minutes, a day —
> twelve series running at once, and every one of them dies and respawns.
>
> Liquidity that has to be rebuilt every window isn't liquidity. So we built a vault that
> outlives the markets it quotes.

*Hold on the thesis line for a beat before scrolling.*

---

## 0:16 — 0:44 · The claim nobody else here can make

**Screen:** scroll to the live order book on the dashboard. Abadi's own level, tagged.

> That's our quote, inside the venue's book, read live in your browser — ours because the
> venue's own owner field says so.
>
> Twelve other projects in this hackathon read this venue, score it, or wrap it. We are the
> only one that puts capital into it. So we are the only one that can be asked whether the
> book got better.

**Cut to:** `docs/evidence/impact-2026-08-31.txt`.

> We rebuilt every window we've ever quoted, twice, from the venue's own order rows — once
> with our orders in and once with them removed.
>
> Seventy windows. The spread was two point four nine percent without us and one point nine
> two percent with us. **Five point eight ticks tighter. Twenty-three percent narrower.**
> Tighter on sixty-six of seventy, wider on none.

*Hold on the table.*

---

## 0:44 — 1:12 · The part that is actually hard

**Screen:** the custody table, then `src/LiquidityVault.sol` at `quote`.

> Here's the problem nobody warns you about. BinaryPool has no operator gate — give a bot a
> key that can trade and that key can also withdraw. Every market-making vault on this venue
> has to solve that before it quotes once.
>
> Ours solves it by owning its own orders. The vault holds the collateral and places the
> orders itself. The operator key chooses a price and a size and can do nothing else. It
> cannot move a token, and there is no function that would let it.

**Run:** `forge test` — let the green line land on screen.

> A hundred and fifteen tests, nine of them against the real venue on a fork. Ninety-seven
> percent line coverage on the vault, and every one of its forty-three functions.

---

## 1:12 — 1:40 · The chain closes the position

**Screen:** the explorer, on transaction
`0x2f75001ea73bd66cf62649841542a2d8b74cad22afa1513e5e6463730a009f50`.

> A window expired at seventeen hundred UTC. No bot ran. Nobody called anything.
>
> Somnia's reactivity precompile woke the vault at the second it was armed for, and the
> vault settled its own position — `CallbackFired`, `Settled`, `Swept`. From the chain, for
> the chain, with the operator key sitting idle.

*Point at the three events in the log list.*

---

## 1:40 — 2:12 · The loss we found, and what we did about it

**Screen:** `docs/evidence/ledger-2026-09-02.md`, on the Summary block.

> Now the uncomfortable part, which I'd rather show you than have you find.
>
> This project once published a two-point-three-seven percent return. That number was
> wrong — not invented, worse. The ledger summed the episodes that closed into a complete
> set and silently dropped the ones that went one-sided. It could not produce a loss.
> Neither could the chart. We found it by auditing ourselves and published the correction.
>
> What it exposed was the real risk: one leg fills, the market walks away from the other,
> and the vault is holding a direction worth one or nothing. Eighteen of those, averaging
> **minus twenty-six percent**, one of them a total loss.

*Beat.*

> So the vault stopped carrying them. It crosses the book and buys the missing side, and
> the pair is worth exactly one either way. Six of those so far: **minus four percent**
> instead of minus twenty-six. And it refused thirty-four times, when the price to get flat
> was worse than the risk of standing still.

---

## 2:12 — 2:32 · What we found in the venue

**Screen:** `docs/SDK-FEEDBACK.md`, scrolled through the issue headings.

> Sixteen reproducible defects in DreamDEX and its SDK, each with a transaction hash.
>
> A pool freezes its whole order book the moment a window expires — including the two calls
> the SDK documents as the permissionless way to get your escrow out. Two windows sat frozen
> for two days with a hundred and ninety-six dollars of ours behind them. The way out was
> `voidExpired`, documented nowhere near where you'd look. The vault takes that hatch itself
> now.
>
> And the pools are beacon proxies: the implementation can change under a live position with
> no address change and no version to pin.

---

## 2:32 — 2:45 · Close

**Screen:** back to the dashboard, live numbers ticking.

> Abadi is a market maker that survives its own markets expiring, a vault that settles itself
> when nobody is watching, and a measurably tighter book for everyone else trading it.
>
> Every number you've seen is read from the chain, including the ones we'd rather not show
> you.

*End on the live dashboard, not on a slide.*

---

## Facts to keep straight on camera

Get these wrong and a judge who checks will discount everything else.
**Re-read every live figure the morning you record.**

| Claim | The number, as of 2026-09-02 |
|---|---|
| Unit tests | 115 — **run `forge test` and say what it prints** |
| Fork tests against the real venue | 9 |
| Browser tests | 77 |
| Coverage | 97.25% of lines and 43/43 functions on `LiquidityVault.sol` |
| Deployments | 13 vaults, 26 Aug – 31 Aug |
| Per share | **1.003178**, read off the chain 2026-09-02 17:00 UTC — **re-read it** |
| Depositors | **+30.40 tUSDC, +0.32%** at that same read. The 14:06 ledger file says −12.90; the vault moved between them, and that is what "re-read it" means |
| Realised, every closed episode | −159.10 on 12,807.85 (−1.24%), from the 2026-09-02 ledger |
| Episodes | 136; 19% of filled quotes adverse |
| One-sided: carried vs completed | 18 at −25.98% · 6 at −3.98% |
| Venue spread, with us vs without | 0.0192 vs 0.0249 over 70 windows, tighter on 66 |
| Frozen escrow, recovered | 208.90 back on 196.00 of basis |
| SDK issues filed | 16 |
| `attest.ts` | **MATCH** — the live address runs this source, verified on the explorer |

**Do not say "profitable".** The vault is above par today at +0.32%; realised across every
vault it has ever run is still negative at −1.24%, and 19% of filled quotes go adverse
against the roughly 9% the spread needs. Say what the numbers say.

**Do not name another submission.** The previous cut of this script closed by pointing at a
competitor's project as the thing Abadi needed next. Abadi has had its own fair-value model
since the 31st, backtested against 1,276 resolved windows, where it ties the book — which is
a finding, not a gap.

## The question you will get, and the answer

> *"Your operator key trades. What stops it running off with the money?"*

Cannot transfer, can trade. The vault holds custody and the key cannot reach it — that part
is absolute. What the key can do is quote badly, so the bound on that is on chain too:
`maxQuoteNotional` caps one quote and `maxDeployedBps` caps the whole book as a fraction of
NAV, both governor-set. Deposits also carry a 300-second redeem delay, capped at an hour, so
the settle sandwich costs an attacker time they have to be right through.
