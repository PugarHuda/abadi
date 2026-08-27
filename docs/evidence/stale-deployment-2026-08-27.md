# The live address was not the code — 2026-08-27

The market the vault was quoting resolved overnight. `settle()` was the one value path
never exercised on chain, and this was the window to exercise it. It reverted with empty
data.

```
$ cast call $VAULT "settle(uint256)(uint256)" 0 --from $OPERATOR
Error: execution reverted, data: "0x"
```

Empty data is not a custom error. It is what a contract returns when the selector does
not exist and there is no fallback. So the question was not why `settle` failed — it was
whether `settle` was there at all.

## Selector diff against the deployed bytecode

```
MISSING  settle(uint256)
MISSING  flatten(uint256)
MISSING  outcomeToken()
MISSING  armSweep(uint64) / armed(uint256) / onEvent(address,bytes32[],bytes)
MISSING  transferGovernance(address) / acceptGovernance()
  ok     quote / cancelQuote / deposit / withdraw / slots / totalEscrowed
```

`0xbcc310b25961bFd241646505c4baE18a518c0A77` — the address in the README, on the deck, and
in `.vault-addr` — is a build from before `settle`, `flatten`, and `AbadiReactive` existed.
Everything demonstrated through it (the quote, the top of book, the both-legs fill) was
real. Everything *not* demonstrated through it was, without anyone noticing, not even
deployed.

The README said those two were "built and tested, not yet exercised on chain". The second
half was true for a reason nobody had checked.

## The second finding, underneath the first

Redemption was isolated by calling the module directly with the vault as `--from`:

```
$ cast call $MODULE "redeem(uint32,bytes32,bytes32,uint8,uint256)" \
    0 0x00 0x…9a50 0 100000000 --from $VAULT
Error: execution reverted, data: "0xdeda9030"     # InsufficientPermission()

$ cast call $OUTCOME_TOKEN "isOperator(address,address)(bool)" $VAULT $MODULE
false
```

The SDK is explicit: *"the trader approves whichever contract pulls the escrow: the pool
for orders/sets, **the module for redeem**."* Buying needs no ERC-6909 grant — the pool
mints straight to the holder. Only redemption pulls. So a vault missing that one grant
quotes correctly, fills correctly, marks correctly, and discovers at settlement that its
position cannot be turned back into money.

That is the exact failure the last commit added a guard for:

```solidity
if (!outcomeToken_.setOperator(address(module_), true)) revert OperatorGrantFailed();
```

Written on the theory that a token might answer `false` instead of reverting. The theory
was right about the consequence and wrong about the cause: the grant was never attempted,
because the deployed constructor predated the line entirely. The guard is still correct
and now it is also verified — see below.

## What it cost

The market resolved UP:

```
market   0x4AAe0f088f6F11a06A863a0226D79645e071dA29
resolved true    voided false    payoutNumerators [1e7, 0]
```

The vault holds 100 UP + 100 DOWN against a 97.40 basis, worth exactly 100.00 at
settlement. With no `settle`, no `flatten`, and no path that touches the ERC-6909
balances, that position is stranded in the old contract permanently.

```
recovered   4902.60 tUSDC   withdraw()      0x9c654c206d42b54e1727642364c4aedbfbcb54d7bfb1a189cd904fe68c09ebdd
stranded      97.40 tUSDC   no exit exists
```

## The redeploy, and the grant verified

```
LiquidityVault -> 0xbCAe987E3387f74867E56C6DDeA1BC94Af7932b5
                  0xb3945f919b357302ed4a571e788e48fba5c3ff531cebf13e444789866181f365

isOperator(newVault, module)  ->  true          <- the constructor grant lands
outcomeToken()                ->  0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9
settle(uint256)               ->  present
```

Funded with the recovered 4902.60 and quoting again, two windows at once:

```
ETH-0-28AUG26        86400s   0.330 / 0.354   escrow 97.60   0x156d2b2d4271c8a27c4df2af21ae0afc6a2f154d540bbd2db9b7471964d750ef
BTC-0-27AUG26-0400   3600s    0.536 / 0.562   escrow 97.40   0xdc90613bb5b4eac8993334a5de7f952f967610bc2bca5d19081fe7466c48dd37
```

The hour tier is deliberate. Waiting a day for a window to resolve is how `settle` went
unexercised in the first place, so `SHORTEST=1` on `scripts/operator.ts` now sorts tiers
the other way and the settle path gets a window that closes inside the hour.

## What this changes

A passing test suite says the code is right. It says nothing about whether the code is
the code that is running. Sixty-two tests covered `settle` thoroughly and every one of
them ran against a contract that was not on chain.

`.vault-addr` now holds the new address, and it is the only place the address lives.
