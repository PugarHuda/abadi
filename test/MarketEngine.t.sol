// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MarketEngine} from "../src/MarketEngine.sol";

/// @dev Library functions are internal and get inlined, so a revert lands at the same
///      call depth as the cheatcode and `vm.expectRevert` cannot see it. This harness
///      pushes them one frame down.
contract Harness {
    function requireProbability(uint256 p, uint256 one) external pure {
        MarketEngine.requireProbability(p, one);
    }

    function expiryNs(uint64 d, uint64 m) external pure returns (uint64) {
        return MarketEngine.expiryNs(d, m);
    }
}

contract MarketEngineTest is Test {
    /// 1.0 in price units on Shannon: tUSDC has 6 decimals, so 1.0 == 1_000_000.
    /// Verified against a working order — 0.727 goes on the wire as `727000`.
    uint256 constant ONE = 1e6;
    /// precision.price = 3 on this venue, so the grid step is 0.001 == 1000.
    uint256 constant TICK = 1e3;
    /// precision.amount = 3, limits.amount.min = 0.001, so a lot is 1000 at 6 decimals.
    uint256 constant LOT = 1e3;

    /// What mainnet looks like: USDso has 18 decimals, 10^12 away from testnet.
    uint256 constant ONE_MAINNET = 1e18;

    Harness h;

    function setUp() public {
        h = new Harness();
    }

    // ---------------------------------------------------------------- scale

    /// The bug this library exists to prevent, and the one that actually bit us.
    ///
    /// A price built at 1e18 scale is not "slightly wrong" on a 6-decimal venue — it is
    /// 10^12 too large, which reads as a probability of 727 billion. The pool does not
    /// answer with `InvalidPrice`: a buy at that price looks like it would cross the
    /// entire book (`PostOnlyWouldCross`) and a sell looks out of range
    /// (`PriceOutOfBounds`), so the error message points nowhere near the cause.
    function test_aPriceBuiltAtTheWrongScaleIsCaughtHere() public {
        uint256 correct = 727_000; // 0.727 at 6 decimals
        uint256 wrongScale = 727e15; // 0.727 at 18 decimals, handed to a 6-decimal venue

        MarketEngine.requireProbability(correct, ONE);

        vm.expectRevert(abi.encodeWithSelector(MarketEngine.PriceOutOfRange.selector, wrongScale));
        h.requireProbability(wrongScale, ONE);

        // The same number is perfectly valid on an 18-decimal venue. Nothing about the
        // value is wrong — only the scale it is paired with.
        MarketEngine.requireProbability(wrongScale, ONE_MAINNET);
    }

    function test_theSameProbabilityIsADifferentIntegerOnEachNetwork() public pure {
        // 0.05, expressed on each venue.
        assertEq(MarketEngine.floorToTick(50_000, TICK), 50_000, "6-decimal testnet");
        assertEq(MarketEngine.floorToTick(5e16, 1e15), 5e16, "18-decimal mainnet");
        assertEq(uint256(5e16) / uint256(50_000), uint256(1e12), "the two are 10^12 apart");
    }

    // ---------------------------------------------------------------- price

    function test_offGridPricesAreCaughtAndSnapped() public pure {
        uint256 clean = 50_000; // 0.050
        uint256 dirty = 50_007; // 7 units off the 0.001 grid

        assertTrue(MarketEngine.isOnTick(clean, TICK), "0.050 is on the grid");
        assertFalse(MarketEngine.isOnTick(dirty, TICK), "off-grid must be caught");
        assertEq(MarketEngine.floorToTick(dirty, TICK), clean, "snapping recovers it");
    }

    function test_floorAndCeilBracketThePrice() public pure {
        uint256 p = 727_400; // between two ticks
        uint256 lo = MarketEngine.floorToTick(p, TICK);
        uint256 hi = MarketEngine.ceilToTick(p, TICK);
        assertEq(lo, 727_000);
        assertEq(hi, 728_000);
        assertTrue(lo <= p && p <= hi, "brackets");
        assertEq(MarketEngine.ceilToTick(lo, TICK), lo, "ceil is idempotent on-grid");
    }

    function test_probabilityBoundsAreExclusive() public {
        vm.expectRevert(abi.encodeWithSelector(MarketEngine.PriceOutOfRange.selector, uint256(0)));
        h.requireProbability(0, ONE);
        vm.expectRevert(abi.encodeWithSelector(MarketEngine.PriceOutOfRange.selector, ONE));
        h.requireProbability(ONE, ONE);
        h.requireProbability(1, ONE); // one unit of probability is still tradable
        h.requireProbability(ONE - 1, ONE);
    }

    /// Measured live 2026-08-26: ask(Down) == 1 - bid(Up) exactly, every market and tier.
    /// The venue keeps ONE book and renders the other side from it.
    function testFuzz_mirrorIsAnInvolution(uint256 p) public pure {
        p = bound(p, 1, ONE - 1);
        assertEq(MarketEngine.mirror(MarketEngine.mirror(p, ONE), ONE), p);
    }

    // ------------------------------------------------------------- quantity

    function test_quantizeFloorsToZeroBelowOneLot() public pure {
        assertEq(MarketEngine.quantize(LOT - 1, LOT), 0, "must floor to zero, not round up");
        assertEq(MarketEngine.quantize(LOT, LOT), LOT);
        assertEq(MarketEngine.quantize(LOT * 3 + 7, LOT), LOT * 3);
    }

    function test_contractsFor_realNumbers() public pure {
        // 10 tUSDC of premium at 0.727 is 13.755... contracts; the 0.001 lot grid floors
        // it to 13.755. The remainder is deliberately unspent — rounding up would
        // overspend the premium, which testFuzz_costNeverExceedsPremium guards.
        uint256 q = MarketEngine.contractsFor(10e6, 727_000, LOT, ONE);
        assertEq(q, 13_755_000);
        assertEq(q % LOT, 0, "on the lot grid");
    }

    function test_contractsFor_returnsZeroWhenPremiumCannotAffordALot() public pure {
        assertEq(MarketEngine.contractsFor(1, 990_000, LOT, ONE), 0);
    }

    /// The money invariant: buying never costs more than the premium budgeted.
    function testFuzz_costNeverExceedsPremium(uint256 premium, uint256 price) public pure {
        premium = bound(premium, 0, 1e15);
        price = bound(price, TICK, ONE - 1);
        price = MarketEngine.floorToTick(price, TICK);
        if (price == 0) return;

        uint256 q = MarketEngine.contractsFor(premium, price, LOT, ONE);
        assertLe(MarketEngine.costOf(q, price, ONE), premium, "cost must never exceed premium");
    }

    function test_costRoundsUpSoThePoolIsNeverShort() public pure {
        // 1 unit of quantity at 0.5 costs a true 0.5; the pool must be handed 1.
        assertEq(MarketEngine.costOf(1, ONE / 2, ONE), 1);
        assertEq(MarketEngine.costOf(0, ONE / 2, ONE), 0);
    }

    /// A two-sided pair costs (1 - spread), and that is the whole LiquidityVault thesis.
    function test_aPairCostsOneMinusTheSpread() public pure {
        uint256 qty = 100e6; // 100 contracts
        uint256 bid = 696_000; // 0.696
        uint256 ask = 716_000; // 0.716 -> 2% spread
        uint256 pair = MarketEngine.costOf(qty, bid, ONE)
            + MarketEngine.costOf(qty, MarketEngine.mirror(ask, ONE), ONE);
        assertEq(pair, 98e6, "100 contracts a side cost 98, not 100");
    }

    // ----------------------------------------------------------------- time

    /// The six tiers measured live: 60s, 300s, 900s, 3600s, 14400s, 86400s.
    function test_headroomScalesWithTierInsteadOfBeingFixed() public pure {
        uint16 tenPercent = 1000; // bps
        assertEq(MarketEngine.headroomSec(60, tenPercent), 6);
        assertEq(MarketEngine.headroomSec(900, tenPercent), 90);
        assertEq(MarketEngine.headroomSec(86400, tenPercent), 8640);
    }

    function test_aFixed300sHeadroomWouldRejectTheFastTiersEntirely() public pure {
        uint64 nowSec = 1_000_000;
        assertTrue(MarketEngine.hasHeadroom(nowSec, nowSec + 50, 60, 1000), "10% of 60s = 6s");
        assertFalse(MarketEngine.hasHeadroom(nowSec, nowSec + 5, 60, 1000), "inside the buffer");
        assertFalse(MarketEngine.hasHeadroom(nowSec, nowSec, 60, 1000), "already expired");
    }

    function test_expiryNsIsCappedAtMarketExpiryAndNeverZero() public {
        assertEq(h.expiryNs(1_000, 5_000), 1_000 * 1e9, "own deadline wins when sooner");
        assertEq(h.expiryNs(9_000, 5_000), 5_000 * 1e9, "capped at market expiry");

        vm.expectRevert(abi.encodeWithSelector(MarketEngine.PriceOutOfRange.selector, uint256(0)));
        h.expiryNs(0, 0); // 0 would revert on-chain as OrderAlreadyExpired
    }
}
