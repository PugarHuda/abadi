# Making this chain's reverts readable, for everyone

**2026-09-06.** This project has spent two weeks reading reverts that decode to nothing.
`docs/SDK-FEEDBACK.md` records sixteen defects and several of them are *only* identifiable by
a bare four-byte selector, because the venue's contracts are unverified beacon proxies and
their errors are in no public database.

That is fixable by anyone, for free, in twenty minutes, and it stays fixed for every other
team on Somnia. So it is done.

## What could not be decoded before

Queried against `api.4byte.sourcify.dev` (the signature database Foundry, Blockscout and
most tracers resolve against) *before* uploading anything:

```
0x1ff09bee -> MarketNotSettled()        already known
0x8afbce93 -> null                      SDK-FEEDBACK #15, the frozen-book revert
0xff429c07 -> null                      SDK-FEEDBACK #14
```

`0x8afbce93` is what all four of the venue's cancel paths answer with once a window expires —
`cancelOrder`, `cancelOrders`, `cancelExpiredOrders`, `sweepExpiredAtLevel`. It is the error
that froze 196 of escrow for two days, and it decoded to nothing for every integrator on the
chain.

## What was uploaded

**Abadi's own contracts**, via Foundry:

```
forge selectors upload --all
  -> Selectors successfully uploaded to OpenChain
```

60 custom errors, plus every function and event. Spot-checked afterwards:

```
0x41ae8a91 -> SizeBelowFilled(uint256,uint256)
0xf465b46d -> PoolAnsweredStrangely(address,uint128)
0x10733b80 -> DepositMintsNothing(uint256)
0x71ca2b95 -> LastShareWhileOpen(uint256)
```

**The venue's own ABIs**, taken from the installed SDK
(`contractErrorsAbi`, `eventsAbi`, `actionsAbi`, `machineryAbi`) and posted to
`https://api.4byte.sourcify.dev/signature-database/v1/import`:

| | sent | newly registered | already known | rejected |
|---|---|---|---|---|
| functions and errors | 603 | **322** | 276 | 5 |
| events | 47 | **38** | 7 | 2 |

**360 signatures that nobody could decode this morning now decode for anybody**, on the
database that `cast 4byte`, Foundry traces and Blockscout all read. Verified after the fact:

```
0xcfb9cfb3 -> AccountNotFlat()
0x2dd88614 -> AdlBadBankruptcyPrice()
0x7b49b6a2 -> AdlFlipNotAllowed()
0x4a4f1689 -> AdlSelfSettle()
```

Also posted to `4byte.directory`, the other widely-read database:
`90 processed, 38 imported, 52 duplicates`.

## What this did NOT fix, and why that matters

**`0x8afbce93` still decodes to nothing, and now we know why.** Every signature in the SDK's
error table was hashed and compared:

```
418 error entries in contractErrorsAbi -> 418 unique selectors
0x8afbce93  NOT PRESENT
0xff429c07  NOT PRESENT
```

So the two selectors this project could not name are not merely missing from a public
database — they are missing from the venue's own generated table. That is SDK-FEEDBACK #16
measured rather than suspected: `contractErrorsAbi` is generated from a commit that predates
the beacon implementation the pools actually run. Uploading the table cannot fix a name it
does not contain, and no claim here says otherwise.

**`4byte.directory` cannot ingest custom errors at all.** Its `import-abi` endpoint rejects
an ABI containing `error` entries outright ("Could not validate ABI"), and `import-solidity`
parsed a file of 60 error declarations as `num_processed: 0`. Functions and events go in
fine. Anyone relying on that service alone to decode a modern Solidity revert is relying on
nothing; Sourcify's database is the one that handles them.

## Reproducing

```bash
forge build && forge selectors upload --all

# before/after on any selector
curl -s "https://api.4byte.sourcify.dev/signature-database/v1/lookup?function=0x8afbce93"
```

The venue upload is a dozen lines: import the four ABI arrays from
`node_modules/@somnia-chain/markets-sdk/dist/`, render each entry as `name(type,type)`, and
POST `{function: [...], event: [...]}` to the import endpoint. No key, no account, no chain.
