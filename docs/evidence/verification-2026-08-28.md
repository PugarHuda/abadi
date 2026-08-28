# Source verification — 2026-08-28

For two days every vault this project deployed was unverified on the Shannon explorer.
A judge clicking the address saw bytecode. `scripts/attest.ts` proved the bytecode was
this source, but that is our script saying so; verification is the explorer saying so.

## Everything that was tried on the real contract

| route | result |
|---|---|
| `forge verify-contract --verifier blockscout` (Etherscan-style API) | `Fail - Unable to verify` |
| Blockscout v2 `verification/via/standard-input`, forge's own standard JSON | accepted, never verified |
| same, with `constructor_args` and full `src/…:LiquidityVault` name | accepted, never verified |
| Blockscout v2 `verification/via/flattened-code`, `forge flatten` output | accepted, never verified |
| Sourcify | `Chain 50312 not found` |

Settings were checked against the artifact's own metadata: same remappings, optimizer
200, `viaIR: true`, `bytecodeHash: ipfs`, `evmVersion: osaka`. Twenty-nine sources in
both. Nothing to fix on our side, and no diagnostic from theirs.

## The experiment that answered it

A contract too small to have any other reason to fail, deployed twice from the same
toolchain, differing only in the EVM target:

```solidity
contract VerifyProbe {
    uint256 public immutable seed;
    constructor(uint256 seed_) { seed = seed_; }
    function twice() external view returns (uint256) { return seed * 2; }
}
```

```
--evm-version osaka    0x5e89175C7CE79D494C2CB44Fe5728584AAD9a4AD    Fail - Unable to verify
--evm-version cancun   0xe4DB4F1edd1EB74A28111eDE373E89b19CE5ed6f    Pass - Verified
```

`GET /api/v2/smart-contracts/verification/config` lists `osaka` among the supported EVM
versions. The verifier accepts the submission and cannot reproduce the build. Reported
as SDK feedback #11.

## The fix, and v8

```toml
evm_version = "cancun"
```

Nothing in the vault needs an opcode newer than cancun. The change alters bytecode, so
under this repository's own rule — the live address runs this source — it meant one more
deployment:

```
v7 slot 0 flattened     +2.40           0xa21d9a3d…
v8 deployed             0xE0E59F39a5c04AD768f7e3fDae8e2FdAC68DebCB
                        0x4b0850431af378c75d19404bd502e86eb1d8fb70e246d8d35d5a3c2214a3562a
attest                  MATCH
forge verify-contract   Pending in queue  ->  Pass - Verified
explorer                is_verified: true    name: LiquidityVault
```

Eight deployments. This one changed no behaviour; it changed what a stranger can read.
