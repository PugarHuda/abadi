// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The CLOB pool a binary market trades on.
/// @dev Signatures verified against @somnia-chain/markets-sdk@0.28.1 `binaryPoolWriteAbi`,
///      which the SDK states mirrors the on-chain BinaryPool exactly.
///
///      CRITICAL: the generic spot `placeOrder` / `placeOrderFor` / `amendOrder` entries
///      **revert `UseBinaryPlacement`** on a binary pool. Binary placement is its own
///      function with an explicit order kind. Reaching for the spot signature is a silent
///      trap — the ABI is present, the call always fails.
///
///      Settlement lives on the POOL, not the market: approve the pool for collateral and
///      outcome tokens, then call its methods directly.
interface IBinaryPool {
    /// @param kind      {ORDER_KIND}. The outcome side is explicit, not a bool.
    /// @param price     ALWAYS the YES-side price, 1e18-scaled, on the tick grid.
    ///                  A BUY_NO at YES-price q costs (1 - q) per contract.
    /// @param userData  Free 64-bit tag. v2 leaves it entirely to the caller —
    ///                  Abadi keys each quote's market and side through it.
    /// @dev `payable` mirrors the on-chain selector; binary pools take no msg.value.
    ///      `builderFeeBpsTimes1k` must be uint96 — the width is selector-critical.
    function placeBinaryOrder(
        uint8 kind,
        uint256 price,
        uint256 quantity,
        uint64 expireTimestampNs,
        uint8 orderType,
        uint8 selfMatchingOption,
        address builder,
        uint96 builderFeeBpsTimes1k,
        uint64 userData
    ) external payable returns (bool success, uint128 id);

    /// @dev Exists, but BinaryPool has no operator gate, so it cannot be used to delegate
    ///      placement to a bot key. Confirmed by the DreamDEX team: the working shape is
    ///      a contract that owns its own orders. That is what Abadi is.
    function placeBinaryOrderFor(
        address owner,
        uint8 kind,
        uint256 price,
        uint256 quantity,
        uint64 expireTimestampNs,
        uint8 orderType,
        uint8 selfMatchingOption,
        address builder,
        uint96 builderFeeBpsTimes1k,
        uint64 userData
    ) external payable returns (bool success, uint128 id);

    function cancelOrder(uint128 orderId) external;

    /// @notice The pool's own record of a resting order.
    /// @dev REVERTS (`IncorrectOrder`) for an id the pool has no ACTIVE order for —
    ///      unknown, filled, cancelled, or replaced by a reduce. That revert is the
    ///      answer "nothing is resting under this id", so callers catch it rather than
    ///      treating it as a failure.
    function getOrder(uint128 orderId) external view returns (PoolOrder memory);
    function cancelExpiredOrders(uint128[] calldata orderIds) external;
    function reduceOrder(uint128 orderId, uint256 newQuantityRemaining) external;

    /// @notice Housekeeping: clears expired orders resting at one price level.
    function sweepExpiredAtLevel(bool isBid, uint256 price, uint256 maxCount)
        external
        returns (uint256 cleaned);

    /// @notice 1 collateral -> 1 YES + 1 NO, with independent recipients.
    function mintSet(address yesTo, address noTo, uint256 amount) external;

    /// @notice 1 YES + 1 NO -> 1 collateral.
    function burnSet(uint256 amount) external;
}

/// @notice On-chain settlement reads on the per-window market contract.
/// @notice One resting order, as the pool itself keeps it.
/// @dev Field order matches the venue's `getOrder` return exactly.
struct PoolOrder {
    uint128 orderId;
    bool isBid;
    address owner;
    uint64 userData;
    uint256 price;
    uint256 fullQuantity;
    uint256 quantityRemaining;
    uint64 expireTimestampNs;
}

interface IBinaryMarket {
    function isResolved() external view returns (bool);
    function isVoided() external view returns (bool);
    function payoutNumerators() external view returns (uint256[] memory);
    function pool() external view returns (address);
    /// @notice Seconds after `expiry` the oracle still has to answer.
    /// @dev `expiry + settlementWindow` is the instant `voidExpired` opens. 300s on
    ///      Shannon's binary windows.
    function settlementWindow() external view returns (uint64);
    /// @notice The dead-oracle escape hatch: flip the market Voided without the oracle.
    /// @dev Permissionless, gated on-chain by `block.timestamp >= expiry +
    ///      settlementWindow`. A voided market pays 0.5 on both sides, so every holder
    ///      is made whole at what they put in. It writes the market directly and
    ///      bypasses the module, so the oracle adapter's `onResolved` never fires and
    ///      the hub's earmark is never released — `syncSettlement` is the nudge that
    ///      does that, and `finalizeMarket` then moves the pool's backing into
    ///      settlement. Redemption finds nothing without both.
    function voidExpired() external;
}

/// @notice `kind` on `placeBinaryOrder`. Price is always quoted YES-side.
/// @dev These four are the venue's four fill paths. BUY_YES crossing BUY_NO needs no
///      seller at all — the pool mints a fresh YES/NO pair from the two buyers'
///      combined collateral. That is what makes zero-inventory quoting possible:
///
///        BUY_YES @ p        escrows p        per contract
///        BUY_NO  @ p + s    escrows 1-(p+s)  per contract   (YES-side price)
///        ------------------------------------------------
///        pair cost          1 - s            and both fills leave a complete set
///
///      A filled pair is worth exactly 1 at settlement regardless of outcome, so the
///      spread `s` is captured with no directional exposure.
library ORDER_KIND {
    uint8 internal constant BUY_YES = 0;
    uint8 internal constant SELL_YES = 1;
    uint8 internal constant BUY_NO = 2;
    uint8 internal constant SELL_NO = 3;
}

/// @notice `orderType` on `placeBinaryOrder`.
/// @dev Verified against markets-sdk `trade.ts` ORDER_TYPE.
library ORDER_TYPE {
    uint8 internal constant LIMIT = 0; // GTC — rests
    uint8 internal constant FILL_OR_KILL = 1;
    uint8 internal constant IOC = 2; // fill what crosses now, cancel the rest
    uint8 internal constant POST_ONLY = 3; // rest only, never takes
}

/// @notice The shared ERC-6909 singleton holding every market's outcome tokens.
/// @dev Up and Down are token IDs on ONE contract, not separate ERC-20s.
///      Deployed at 0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9 on both networks.
interface IOutcomeToken6909 {
    function balanceOf(address owner, uint256 id) external view returns (uint256);
    function isOperator(address owner, address spender) external view returns (bool);

    /// @notice One grant covers every id and every market.
    /// @dev Required before redemption: the module PULLS the winning outcome tokens
    ///      from the caller, then routes them through the settlement singleton.
    function setOperator(address spender, bool approved) external returns (bool);
}
