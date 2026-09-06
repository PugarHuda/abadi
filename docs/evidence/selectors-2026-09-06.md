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

**That last line was the weak part of this file and it has been redone — see the correction
at the bottom.** It was done by hand, it covered a fraction of what went to Sourcify, and
two spot checks against it later came back empty with no way to tell which 38 had gone in.

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

**`4byte.directory`'s BULK endpoints cannot ingest custom errors.** Its `import-abi` rejects
an ABI containing `error` entries outright ("Could not validate ABI"), and `import-solidity`
parsed a file of 60 error declarations as `num_processed: 0`.

**The conclusion drawn from that was wrong, and the correction is below:** the bulk importers
are not the only door. `POST /api/v1/signatures/` takes one signature at a time and accepts
custom errors without complaint. The earlier version of this paragraph said the service
"cannot ingest custom errors at all", which was a property of the endpoint being used rather
than of the database.

## Reproducing

```bash
forge build && forge selectors upload --all

# before/after on any selector
curl -s "https://api.4byte.sourcify.dev/signature-database/v1/lookup?function=0x8afbce93"
```

The venue upload is a dozen lines: import the four ABI arrays from
`node_modules/@somnia-chain/markets-sdk/dist/`, render each entry as `name(type,type)`, and
POST `{function: [...], event: [...]}` to the import endpoint. No key, no account, no chain.

---

## Correction and second upload, 2026-09-06 16:0x UTC

The hand-done half of this file is now a script: `scripts/selectors.mjs`, `npm run selectors`
(read-only; `-- --send` publishes). It collects the vault's own ABI plus **every** array the
venue's SDK ships that has the shape of an ABI — the package root and its `dist/` files both,
because the two do not agree: the export map does not expose `contractErrorsAbi`, and that is
the 418-entry error table, the single most useful thing on the list.

That is 15 more ABIs than the four this file originally named:

```
804 functions and errors, 74 events, deduplicated
newly registered 637   already known 241   refused 0
```

on `4byte.directory`, one `POST /api/v1/signatures/` each, custom errors included. Read back
afterwards, having been empty on the same query two hours earlier:

```
0xcfb9cfb3 -> AccountNotFlat()                      (the venue's)
0x95c9f825 -> HalfSpreadTooSmall(uint256,uint256)   (ours, added today)
0x8afbce93 -> still empty                           (still not in the venue's own table)
```

`forge selectors upload --all` was re-run for OpenChain in the same sitting, so the three
errors this repo added on the 6th decode there too (`0x95c9f825`, `0x30013f54`, `0x8ad4cdaf`).

**What this changes for anyone else on Somnia:** a revert from a DreamDEX pool now decodes in
both of the databases that block explorers and tracers read, not one. The command that does it
is in the repo, so the next person to add an ABI does not have to work out the endpoint.
