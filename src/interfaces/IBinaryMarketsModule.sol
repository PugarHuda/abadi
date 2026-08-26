// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice DreamDEX BinaryMarketsModule — the user-facing markets contract.
/// @dev Signatures verified against @somnia-chain/markets-sdk@0.28.1
///      `binaryModuleWriteAbi` / `binaryModuleReadAbi`, which the SDK states
///      mirror BinaryMarketsModule.sol exactly.
///      Deployed at 0x3ecC694Cef705358864a646142ac17A90E29e388 on BOTH
///      testnet (50312) and mainnet (5031) — CREATE3, so the address is identical.
interface IBinaryMarketsModule {
    /// @notice Full per-market record. Read this, never a cached pool address:
    ///         pools are recycled across windows.
    struct Market {
        uint256 oracleQuestionId;
        uint8 outcomeSlotCount;
        uint8 voidPolicy;
        address collateral;
        uint32 originOperatorId;
        bytes32 originVenueId;
        address oracleAdapter;
        address creator;
        address market;
        address pool;
        uint256 yesId;
        uint256 noId;
        uint64 tradingStart;
        uint64 expiry;
    }

    function markets(bytes32 marketId)
        external
        view
        returns (
            uint256 oracleQuestionId,
            uint8 outcomeSlotCount,
            uint8 voidPolicy,
            address collateral,
            uint32 originOperatorId,
            bytes32 originVenueId,
            address oracleAdapter,
            address creator,
            address market,
            address pool,
            uint256 yesId,
            uint256 noId,
            uint64 tradingStart,
            uint64 expiry
        );

    function marketNonce(bytes32 marketId) external view returns (uint64 nonce);
    function settlement() external view returns (address);

    /// @notice 1 collateral -> 1 Up + 1 Down. `operatorId`/`venueId` are attribution-only (may be 0).
    function mintCompleteSet(uint32 operatorId, bytes32 venueId, bytes32 marketId, uint256 amount) external;

    /// @notice 1 Up + 1 Down -> 1 collateral.
    function mergeCompleteSet(uint32 operatorId, bytes32 venueId, bytes32 marketId, uint256 amount) external;

    /// @notice Pulls the caller's winning outcome tokens and redeems through settlement.
    /// @param outcomeIdx 0 = UP, 1 = DOWN.
    function redeem(uint32 operatorId, bytes32 venueId, bytes32 marketId, uint8 outcomeIdx, uint256 amount) external;

    function redeemMany(
        uint32 operatorId,
        bytes32 venueId,
        bytes32[] calldata marketIds,
        uint8[] calldata outcomeIdxs,
        uint256[] calldata amounts
    ) external;

    // --- permissionless keeper entries (the bounty-trigger fallback path) ---

    /// @notice Sweeps a pool's backing + resolution snapshot to settlement. No-op-guarded.
    function finalizeMarket(bytes32 marketId) external;

    /// @notice Returns a finalized, drained pool to its creator's free list.
    function releasePool(bytes32 marketId) external;

    /// @notice Manually pulls a posted oracle answer if the reactive callback was missed.
    function pokeOracle(uint256 oracleQuestionId) external;
}

/// @notice Market lifecycle states. Only `Trading` accepts orders.
/// @dev Gate every write on the LIVE on-chain status — the indexer lags by seconds.
library MarketStatus {
    uint8 internal constant LISTED = 0;
    uint8 internal constant TRADING = 1;
    uint8 internal constant LOCKED = 2;
    uint8 internal constant RESOLVED = 4;
    uint8 internal constant VOIDED = 5;
}
