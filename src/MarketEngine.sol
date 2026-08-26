// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MarketEngine
/// @notice Pure grid math for DreamDEX binary markets. Every Abadi vault sizes and
///         prices its orders through here, so the venue's sharp edges are paid for once.
/// @dev Units, fixed once and never mixed:
///      - `one`       1.0 in price units = 10 ** collateral.decimals(). NOT 1e18.
///      - `price`     Up-probability scaled by `one`, strictly inside (0, one).
///      - `premium`   collateral units, in the collateral's own decimals.
///      - `quantity`  outcome-token units. One winning contract redeems for exactly
///                    1 collateral unit, so quantity shares the collateral's decimals.
///
///      The scale is NOT 1e18 and must never be hardcoded. Verified against a working
///      order on Shannon: a 0.727 probability is submitted as `727000` on 6-decimal
///      tUSDC. Mainnet USDso has 18 decimals, so the same probability is 727e15 there —
///      a factor of 10^12 apart. Read `decimals()` and pass `one` in; a literal here
///      misprices every order on one of the two networks and nothing reverts to say so.
library MarketEngine {

    error PriceOutOfRange(uint256 price);
    error TickSizeZero();
    error LotSizeZero();

    // ------------------------------------------------------------------ price

    /// @notice True when `price` sits exactly on the venue's tick grid.
    /// @dev The float trap this exists to kill: off-chain, `(0.05).toFixed(18)` yields
    ///      "0.050000000000000003" — three wei off-grid — and the pool rejects it with
    ///      `InvalidPrice`. Nothing that reaches `placeOrder` is ever float-derived;
    ///      it is an integer that passed this check.
    function isOnTick(uint256 price, uint256 tickSize) internal pure returns (bool) {
        if (tickSize == 0) revert TickSizeZero();
        return price % tickSize == 0;
    }

    /// @notice Largest on-grid price at or below `price`. Use when bidding.
    function floorToTick(uint256 price, uint256 tickSize) internal pure returns (uint256) {
        if (tickSize == 0) revert TickSizeZero();
        // forge-lint: disable-next-line(divide-before-multiply) — floor-then-scale IS the grid snap
        return (price / tickSize) * tickSize;
    }

    /// @notice Smallest on-grid price at or above `price`. Use when asking.
    function ceilToTick(uint256 price, uint256 tickSize) internal pure returns (uint256) {
        if (tickSize == 0) revert TickSizeZero();
        uint256 r = price % tickSize;
        return r == 0 ? price : price + (tickSize - r);
    }

    /// @notice Reverts unless `price` is a usable probability: strictly inside (0, 1).
    /// @dev 0 and 1e18 are certainties, not tradable probabilities. Snapping can walk a
    ///      near-boundary price onto one of them, so this runs after snapping, not before.
    function requireProbability(uint256 price, uint256 one) internal pure {
        if (price == 0 || price >= one) revert PriceOutOfRange(price);
    }

    /// @notice The mirrored side. The venue keeps ONE book: measured live on 2026-08-26,
    ///         `ask(Down) = 1 - bid(Up)` held exactly across every market and tier.
    function mirror(uint256 price, uint256 one) internal pure returns (uint256) {
        requireProbability(price, one);
        return one - price;
    }

    // --------------------------------------------------------------- quantity

    /// @notice Snap `amount` down to the lot grid.
    /// @return Zero when the amount does not reach one lot. Callers MUST skip on zero:
    ///         a zero-size order is a guaranteed revert that still costs gas.
    function quantize(uint256 amount, uint256 lotSize) internal pure returns (uint256) {
        if (lotSize == 0) revert LotSizeZero();
        // forge-lint: disable-next-line(divide-before-multiply) — floor-then-scale IS the grid snap
        return (amount / lotSize) * lotSize;
    }

    /// @notice How many contracts `premium` buys at `price`, snapped to the lot grid.
    /// @dev Rounding is downward, so the realised cost can only ever be <= premium.
    ///      Returns 0 when the premium cannot afford a single lot.
    function contractsFor(uint256 premium, uint256 price, uint256 lotSize, uint256 one)
        internal
        pure
        returns (uint256 quantity)
    {
        requireProbability(price, one);
        quantity = quantize((premium * one) / price, lotSize);
    }

    /// @notice Collateral a buy of `quantity` at `price` actually pulls.
    /// @dev Rounded UP: the pool must never be short, and an under-estimate here is the
    ///      "underfunded bot loops paying gas on reverting orders" failure.
    function costOf(uint256 quantity, uint256 price, uint256 one) internal pure returns (uint256) {
        requireProbability(price, one);
        uint256 num = quantity * price;
        return num == 0 ? 0 : (num - 1) / one + 1;
    }

    // ------------------------------------------------------------------- time

    /// @notice Expiry buffer as a fraction of the window, never a fixed number of seconds.
    /// @dev The venue runs six tiers — 60s, 300s, 900s, 3600s, 14400s, 86400s (measured
    ///      live 2026-08-26). A hardcoded 300s headroom rejects the 60s and 300s tiers
    ///      outright and wastes a third of the 900s one.
    function headroomSec(uint64 intervalSec, uint16 bps) internal pure returns (uint64) {
        return uint64((uint256(intervalSec) * bps) / 10_000);
    }

    /// @notice True when the window has enough life left to be worth entering.
    function hasHeadroom(uint64 nowSec, uint64 expirySec, uint64 intervalSec, uint16 bps)
        internal
        pure
        returns (bool)
    {
        if (expirySec <= nowSec) return false;
        return expirySec - nowSec > headroomSec(intervalSec, bps);
    }

    /// @notice Order expiry in nanoseconds, as `placeOrder` wants it.
    /// @dev Passing 0 reverts with `OrderAlreadyExpired`, so a zero deadline is refused
    ///      here rather than on-chain. Capped at the market's own expiry: an order that
    ///      outlives its window is escrow left resting where nothing can fill it.
    function expiryNs(uint64 deadlineSec, uint64 marketExpirySec) internal pure returns (uint64) {
        uint64 s = deadlineSec < marketExpirySec ? deadlineSec : marketExpirySec;
        if (s == 0) revert PriceOutOfRange(0);
        return s * 1_000_000_000;
    }
}
