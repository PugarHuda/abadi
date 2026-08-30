// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LiquidityVault} from "../../src/LiquidityVault.sol";
import {IBinaryMarketsModule} from "../../src/interfaces/IBinaryMarketsModule.sol";
import {IBinaryPool, IBinaryMarket, IOutcomeToken6909, ORDER_KIND, ORDER_TYPE} from "../../src/interfaces/IBinaryPool.sol";

interface IFaucet {
    function faucet(uint256 amount) external;
}

/// @title The vault against the real venue, on a fork of Shannon.
/// @notice Every defect that cost capital on the 27th was one the unit suite could not
///         see, because its mock pool was kinder than the pool. This suite has no mock:
///         it forks Shannon, deploys the vault, quotes a live window, and then plays the
///         taker itself — crossing the vault's own legs through the real BinaryPool so
///         the pair is minted by the real module and merged by the real module.
///
/// @dev Needs two things the unit suite does not: an RPC and a live market.
///      `scripts/fork-test.ts` finds a window with enough headroom and runs this with
///      FORK_MARKET set. Skipped cleanly when either is absent, so `forge test` stays
///      offline by default.
contract VenueForkTest is Test {
    address constant COLLATERAL = 0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E;
    address constant MODULE = 0x3ecC694Cef705358864a646142ac17A90E29e388;
    address constant OUTCOME = 0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9;

    LiquidityVault vault;
    bytes32 marketId;
    address pool;
    uint256 yesId;
    uint256 noId;

    address governor = makeAddr("governor");
    address operator = makeAddr("operator");
    address depositor = makeAddr("depositor");
    address taker = makeAddr("taker");

    uint256 constant SIZE = 100e6;

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        bytes32 mid = vm.envOr("FORK_MARKET", bytes32(0));
        if (bytes(rpc).length == 0 || mid == bytes32(0)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        marketId = mid;

        (,,,,,,,,,, uint256 y, uint256 n,,) = IBinaryMarketsModule(MODULE).markets(marketId);
        yesId = y;
        noId = n;
        // Field 9 is the pool; field 3 is the collateral, and a taker order sent to the
        // collateral reverts with nothing to say — the first run of this file did that.
        (,,,,,,,,, address p,,,,) = IBinaryMarketsModule(MODULE).markets(marketId);
        pool = p;

        vault = new LiquidityVault(
            IERC20(COLLATERAL), IBinaryMarketsModule(MODULE), IOutcomeToken6909(OUTCOME), governor, 1000, 1000
        );
        vm.prank(governor);
        vault.setOperator(operator);

        // The venue's own test collateral mints on demand.
        vm.startPrank(depositor);
        IFaucet(COLLATERAL).faucet(1_000e6);
        IERC20(COLLATERAL).approve(address(vault), 1_000e6);
        vault.deposit(1_000e6, depositor);
        vm.stopPrank();

        // The taker sweeps everything resting at or better than the vault's price, so it
        // needs enough to eat whatever else the live book has there — see _take.
        vm.startPrank(taker);
        IFaucet(COLLATERAL).faucet(10_000e6);
        IERC20(COLLATERAL).approve(pool, type(uint256).max);
        vm.stopPrank();
    }

    /// The module must be able to pull outcome tokens from a freshly constructed vault.
    /// This is the grant v1 never made, discovered at settlement with capital stranded.
    function test_fork_moduleIsOperatorFromConstruction() public view {
        assertTrue(IOutcomeToken6909(OUTCOME).isOperator(address(vault), MODULE), "granted at deploy, on the real token");
    }

    /// Quote inside a live book and read the escrow the real pool actually took.
    function test_fork_quoteEscrowsOneMinusTheSpread() public {
        (uint256 mid, uint256 half) = _insideTheBook();
        uint256 before = vault.idleAssets();

        vm.prank(operator);
        vault.quote(0, marketId, mid, half, SIZE);

        uint256 escrowed = before - vault.idleAssets();
        uint256 spread = 2 * half;
        // BUY_YES pays `mid - half`, BUY_NO pays 1 - (mid + half); together 1 - spread.
        assertEq(escrowed, SIZE - (SIZE * spread) / 1e6, "the real pool took exactly size x (1 - spread)");
        assertEq(vault.totalEscrowed(), escrowed, "derived escrow agrees with what left");
    }

    /// The whole thing: both legs crossed by a real taker through the real pool, the
    /// pair minted by the real module, held as a complete set, merged back by the real
    /// module. No mock anywhere.
    function test_fork_bothLegsFillIntoACompleteSetAndFlattenReturnsOne() public {
        (uint256 mid, uint256 half) = _insideTheBook();
        vm.prank(operator);
        vault.quote(0, marketId, mid, half, SIZE);

        // Cross the vault's BUY_YES with a BUY_NO at the same YES-side price, and its
        // BUY_NO with a BUY_YES at its ask. Two opposite-side buyers, no seller: the
        // pool mints the pair from the combined collateral.
        vm.startPrank(taker);
        _take(ORDER_KIND.BUY_NO, mid - half);
        _take(ORDER_KIND.BUY_YES, mid + half);
        vm.stopPrank();

        uint256 yes = IOutcomeToken6909(OUTCOME).balanceOf(address(vault), yesId);
        uint256 no = IOutcomeToken6909(OUTCOME).balanceOf(address(vault), noId);
        assertEq(yes, SIZE, "vault holds the YES side");
        assertEq(no, SIZE, "vault holds the NO side");
        assertEq(vault.totalEscrowed(), 0, "nothing resting once both legs took");
        assertEq(vault.totalAssets(), 1_000e6 + (SIZE * 2 * half) / 1e6, "NAV marks the set at its size");

        vm.prank(operator);
        uint256 returned = vault.flatten(0);
        assertEq(returned, SIZE, "the real module merged the pair for exactly one apiece");
        assertFalse(vault.slots(0).active, "slot freed");
        assertEq(vault.idleAssets(), 1_000e6 + (SIZE * 2 * half) / 1e6, "the spread is cash now");
    }

    /// The exit that bricked v2. A leg that filled is an id the pool no longer
    /// recognises; cancelling the quote must survive that and pull the other leg.
    function test_fork_cancelQuoteSurvivesAFilledLegOnTheRealPool() public {
        (uint256 mid, uint256 half) = _insideTheBook();
        vm.prank(operator);
        vault.quote(0, marketId, mid, half, SIZE);

        vm.prank(taker);
        _take(ORDER_KIND.BUY_NO, mid - half); // fills only the vault's BUY_YES

        uint256 before = vault.idleAssets();
        vm.prank(operator);
        vault.cancelQuote(0);

        assertGt(vault.idleAssets(), before, "the resting BUY_NO leg's escrow came back");
        assertTrue(vault.slots(0).active, "the slot stays open: it holds YES tokens for settle()");
        assertEq(vault.totalEscrowed(), 0, "nothing resting");
    }

    /// The shape that froze 196 of the live vault's capital for two days: the window
    /// expires and the oracle never answers. Against the real pool this pins three things
    /// the mock could only assert: that the book really does refuse every cancel in the
    /// gap, that `voidExpired` really does open at `expiry + settlementWindow`, and that
    /// the escrow the frozen book would not hand back comes back anyway once the market
    /// is terminal.
    function test_fork_sweepFreesAWindowTheOracleAbandoned() public {
        (uint256 mid, uint256 half) = _insideTheBook();
        vm.prank(operator);
        vault.quote(0, marketId, mid, half, SIZE);
        uint256 escrowed = vault.totalEscrowed();
        assertGt(escrowed, 0, "both legs resting on the real book");

        (,,,,,,,, address market,,,,, uint64 expiry) = IBinaryMarketsModule(MODULE).markets(marketId);
        uint64 window = IBinaryMarket(market).settlementWindow();

        // In the gap: expired, not settled. Measured against this pool at expiry - 5,
        // + 1, + window - 5 and + window + 15, the boundary is exact — the book takes a
        // cancel right up to expiry, refuses every one after it, and takes them again the
        // moment the market is voided. The refusal is 0x8afbce93 and nothing the SDK's
        // generated error table can name.
        uint128 leg = vault.slots(0).yesOrderId;
        vm.warp(uint256(expiry) + 1);
        vm.prank(address(vault));
        vm.expectRevert();
        IBinaryPool(pool).cancelOrder(leg);
        // And the hatch is not open yet either.
        vm.expectRevert();
        IBinaryMarket(market).voidExpired();
        // So the exit says so instead of pretending: the slot and its escrow both stay.
        vm.prank(address(vault));
        vault.releaseSlot(0);
        assertTrue(vault.slots(0).active, "nothing to do yet, and it did nothing");
        assertEq(vault.totalEscrowed(), escrowed, "still owed, still counted");

        // Past the oracle's window the vault closes the whole thing by itself.
        vm.warp(uint256(expiry) + window + 15);
        uint256 before = vault.idleAssets();
        vm.prank(address(vault));
        vault.releaseSlot(0);

        assertTrue(IBinaryMarket(market).isVoided(), "the vault took the hatch");
        assertFalse(vault.slots(0).active, "slot freed");
        assertEq(vault.totalEscrowed(), 0, "nothing left resting");
        assertEq(vault.idleAssets() - before, escrowed, "every cent of the escrow came back");
    }

    // ---------------------------------------------------------------- helpers

    /// An IOC at the vault's price, sized well past the vault's leg. The fork is the live
    /// book at that block, and another maker may be resting inside the vault's price; a
    /// taker for exactly SIZE would fill them and leave the vault untouched — which is
    /// what happened on the first GitHub run. Sweeping the level guarantees the vault's
    /// leg is among what fills, and IOC drops the remainder.
    function _take(uint8 kind, uint256 price) internal {
        (bool ok,) = IBinaryPool(pool).placeBinaryOrder(
            kind, price, 20 * SIZE, uint64((block.timestamp + 3600) * 1e9), ORDER_TYPE.IOC, 0, address(0), 0, 0
        );
        assertTrue(ok, "taker order accepted by the real pool");
    }

    /// A mid and half-spread the vault's own checks accept for this market right now.
    /// The fork is a snapshot, so the book cannot move between read and send.
    function _insideTheBook() internal view returns (uint256 mid, uint256 half) {
        mid = vm.envOr("FORK_MID", uint256(500_000));
        half = vm.envOr("FORK_HALF", uint256(12_000));
        require(half >= vault.minHalfSpread(), "FORK_HALF under the vault floor");
    }
}
