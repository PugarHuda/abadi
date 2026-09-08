# Security policy

Abadi is a testnet project. The vault holds test collateral on Somnia Shannon (chain 50312)
and nothing in it is worth money. Report anyway: the contracts in `src/` are the same source a
mainnet deployment would use, so a finding against them is a finding against that.

## Reporting

Open a [private security advisory](https://github.com/PugarHuda/abadi/security/advisories/new).
The same address is published at
[`/.well-known/security.txt`](https://abadi-wheat.vercel.app/.well-known/security.txt) per RFC 9116.

## Scope

**In scope**
- `src/LiquidityVault.sol`, `src/MarketEngine.sol`, `src/AbadiReactive.sol`
- The deployed vault named in [`/deployments.json`](https://abadi-wheat.vercel.app/deployments.json)
- This site, including the transaction-building code in `web/app.js`

**Out of scope** — report these to Somnia rather than here
- The DreamDEX venue: `BinaryPool`, the markets module, the oracle hub
- The Shannon RPC, the indexer and the block explorer

## What is already known

Two of these are written down rather than hidden, and a report that repeats them is welcome
but will not be news:

- **The operator key cannot transfer collateral out and can trade it away.** It picks the
  market, the price and the size. It is bounded on chain at 500 tUSDC of escrow per quote and
  2,500 bps of NAV across the book; the README's *Custody* section has the reasoning.
- **`src/` was ahead of the deployed vault for two days and is not any more.** One of those
  guards, `SizeBelowFilled`, closed a path where the operator could move the share price 12%
  without sending anything — governor-only, and the governor is the deployer. It went on chain
  with the 2026-09-07 redeploy and `node scripts/attest.ts` now says MATCH. See the README's
  *The source and the chain agree*.

## Disclosure

Testnet, so there is no embargo to negotiate. Findings get written up in `docs/evidence/` with
what they cost, the same as every other failure in this repository.
