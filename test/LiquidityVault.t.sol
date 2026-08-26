// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {LiquidityVault} from "../src/LiquidityVault.sol";
import {MarketEngine} from "../src/MarketEngine.sol";
import {IBinaryMarketsModule, MarketStatus} from "../src/interfaces/IBinaryMarketsModule.sol";
import {IOutcomeToken6909, ORDER_KIND, ORDER_TYPE} from "../src/interfaces/IBinaryPool.sol";
import {AbadiReactive} from "../src/AbadiReactive.sol";
import {SomniaExtensions} from "@somnia-chain/reactivity-contracts/contracts/interfaces/SomniaExtensions.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("Test USDC", "tUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockPool {
    /// @dev The real pool auto-pulls the caller's collateral at placement. A mock that
    ///      skips it makes vault accounting look correct when it is not.
    IERC20 public immutable collateral;

    constructor(IERC20 collateral_) {
        collateral = collateral_;
    }

    struct Placed {
        uint8 kind;
        uint256 price;
        uint256 quantity;
        uint64 expireTimestampNs;
        uint8 orderType;
        uint64 userData;
    }

    Placed[] public placed;
    uint128 public nextId = 1;
    uint128[] public cancelled;
    bool public rejectNext;

    function setRejectNext(bool v) external {
        rejectNext = v;
    }

    function placedCount() external view returns (uint256) {
        return placed.length;
    }

    function placedAt(uint256 i) external view returns (Placed memory) {
        return placed[i];
    }

    function cancelledCount() external view returns (uint256) {
        return cancelled.length;
    }

    function placeBinaryOrder(
        uint8 kind,
        uint256 price,
        uint256 quantity,
        uint64 expireTimestampNs,
        uint8 orderType,
        uint8,
        address,
        uint96,
        uint64 userData
    ) external returns (bool success, uint128 id) {
        if (rejectNext) return (false, 0);
        // BUY_YES escrows `price`; BUY_NO is quoted YES-side and escrows (1 - price).
        uint256 unit = kind == 0 ? price : 1e6 - price;
        uint256 cost = (quantity * unit + 1e6 - 1) / 1e6;
        collateral.transferFrom(msg.sender, address(this), cost);
        placed.push(Placed(kind, price, quantity, expireTimestampNs, orderType, userData));
        id = nextId++;
        success = true;
    }

    function cancelOrder(uint128 orderId) external {
        cancelled.push(orderId);
    }
}

contract MockOutcome6909 {
    mapping(address => mapping(uint256 => uint256)) public bal;
    mapping(address => mapping(address => bool)) public operators;

    function setBalance(address who, uint256 id, uint256 amount) external {
        bal[who][id] = amount;
    }

    function balanceOf(address o, uint256 id) external view returns (uint256) {
        return bal[o][id];
    }

    function isOperator(address o, address s_) external view returns (bool) {
        return operators[o][s_];
    }

    function setOperator(address s_, bool ok) external returns (bool) {
        operators[msg.sender][s_] = ok;
        return true;
    }

    function burn(address who, uint256 id, uint256 amount) external {
        bal[who][id] -= amount;
    }
}

/// @dev Stands in for the per-window market contract's settlement reads.
contract MockMarket {
    bool public isResolved;
    bool public isVoided;
    uint256[] internal _payouts;

    function resolve(uint256 yesPayout, uint256 noPayout) external {
        isResolved = true;
        _payouts = [yesPayout, noPayout];
    }

    function voidIt() external {
        isVoided = true;
        _payouts = [5, 5];
    }

    function payoutNumerators() external view returns (uint256[] memory) {
        return _payouts;
    }

    function pool() external pure returns (address) {
        return address(0);
    }
}

contract MockModule {
    struct Rec {
        address pool;
        uint64 tradingStart;
        uint64 expiry;
        address market;
        uint256 yesId;
        uint256 noId;
    }

    mapping(bytes32 => Rec) public recs;
    MockOutcome6909 public outcome;
    MockUSDC public usdc;

    function wire(MockOutcome6909 o, MockUSDC u) external {
        outcome = o;
        usdc = u;
    }

    function set(bytes32 id, address pool, uint64 tradingStart, uint64 expiry) external {
        recs[id].pool = pool;
        recs[id].tradingStart = tradingStart;
        recs[id].expiry = expiry;
    }

    function setSettlement(bytes32 id, address market, uint256 yesId, uint256 noId) external {
        recs[id].market = market;
        recs[id].yesId = yesId;
        recs[id].noId = noId;
    }

    /// @dev 1 YES + 1 NO -> 1 collateral, at any time. A complete set is worth exactly 1
    ///      regardless of how the market later resolves.
    function mergeCompleteSet(uint32, bytes32, bytes32 marketId, uint256 amount) external {
        Rec memory r = recs[marketId];
        outcome.burn(msg.sender, r.yesId, amount);
        outcome.burn(msg.sender, r.noId, amount);
        usdc.mint(msg.sender, amount);
    }

    /// @dev Mirrors the real module: pulls the caller's outcome tokens, pays collateral.
    ///      A voided market pays half; a resolved one pays 1:1.
    function redeem(uint32, bytes32, bytes32 marketId, uint8 outcomeIdx, uint256 amount) external {
        Rec memory r = recs[marketId];
        // The real module redeems the side the caller names. A mock that guesses the id
        // hides a caller passing the wrong outcomeIdx — exactly the bug worth catching.
        uint256 id = outcomeIdx == 0 ? r.yesId : r.noId;
        outcome.burn(msg.sender, id, amount);
        uint256 payout = MockMarket(r.market).isVoided() ? amount / 2 : amount;
        usdc.mint(msg.sender, payout);
    }

    function markets(bytes32 marketId)
        external
        view
        returns (
            uint256,
            uint8,
            uint8,
            address,
            uint32,
            bytes32,
            address,
            address,
            address,
            address,
            uint256,
            uint256,
            uint64,
            uint64
        )
    {
        Rec memory r = recs[marketId];
        return (0, 2, 0, address(0), 0, bytes32(0), address(0), address(0), r.market, r.pool, r.yesId, r.noId, r.tradingStart, r.expiry);
    }
}

contract LiquidityVaultTest is Test {
    uint256 constant ONE = 1e6; // 1.0 in price units: tUSDC has 6 decimals
    uint256 constant TICK = 1e3; // 0.001 — precision.price = 3 on this venue
    uint256 constant LOT = 1e3; // 0.001 contracts

    MockUSDC usdc;
    MockModule module;
    MockPool pool;
    MockOutcome6909 outcome;
    MockMarket market;
    LiquidityVault vault;

    uint256 constant YES_ID = 111;
    uint256 constant NO_ID = 222;

    address governor = address(0x9012);
    address operator = address(0x0B07);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    bytes32 constant MARKET = bytes32(uint256(0xB7C));

    // A 900s window, freshly opened.
    uint64 tradingStart;
    uint64 expiry;

    function setUp() public {
        vm.warp(1_800_000_000);
        tradingStart = uint64(block.timestamp);
        expiry = tradingStart + 900;

        usdc = new MockUSDC();
        module = new MockModule();
        pool = new MockPool(IERC20(address(usdc)));
        outcome = new MockOutcome6909();
        market = new MockMarket();
        module.set(MARKET, address(pool), tradingStart, expiry);
        module.setSettlement(MARKET, address(market), YES_ID, NO_ID);
        module.wire(outcome, usdc);

        vault = new LiquidityVault(
            IERC20(address(usdc)),
            IBinaryMarketsModule(address(module)),
            IOutcomeToken6909(address(outcome)),
            governor,
            TICK,
            LOT
        );
        // priceOne is read from the token: 10 ** 6. Never hardcoded.
        assertEq(vault.priceOne(), ONE, "price scale comes from collateral decimals");
        vm.prank(governor);
        vault.setOperator(operator);

        usdc.mint(alice, 1_000e6);
        usdc.mint(bob, 2_000e6);
    }

    function _deposit(address who, uint256 amount) internal {
        vm.startPrank(who);
        usdc.approve(address(vault), amount);
        vault.deposit(amount, who);
        vm.stopPrank();
    }

    // ------------------------------------------------------------- custody

    /// The whole custody argument: the operator key steers quotes and nothing else.
    /// This is the property the DreamDEX team said a contract must provide, because
    /// BinaryPool has no operator gate of its own.
    function test_operatorCannotMoveAnyFunds() public {
        _deposit(alice, 500e6);

        uint256 aliceShares = vault.balanceOf(alice); // read outside the revert window

        vm.startPrank(operator);
        // No withdraw path exists for a non-shareholder: 4626 burns the caller's shares.
        vm.expectRevert();
        vault.withdraw(1e6, operator, operator);
        vm.expectRevert();
        vault.redeem(1, operator, operator);
        // Nor can it seize someone else's: 4626 requires an allowance from the owner.
        vm.expectRevert();
        vault.redeem(aliceShares, operator, alice);
        vm.stopPrank();

        assertEq(usdc.balanceOf(operator), 0, "operator holds nothing");
        assertEq(vault.totalAssets(), 500e6, "assets untouched");
    }

    function test_onlyOperatorCanQuote() public {
        _deposit(alice, 500e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LiquidityVault.NotOperator.selector, alice));
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), 100e6);
    }

    function test_onlyGovernorCanRepointOperator() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(LiquidityVault.NotGovernor.selector, operator));
        vault.setOperator(bob);
    }

    // --------------------------------------------------------------- quoting

    /// The core economics: a two-sided pair costs (1 - spread), not 1.
    /// That is what "zero inventory" buys, and it is the reason making is viable here.
    function test_pairCostsOneMinusSpread() public {
        _deposit(alice, 500e6);

        uint256 mid = 500_000; // 0.500 — price units are collateral-scaled, not 1e18
        uint256 half = 15_000; // 0.015 -> 3% spread, matching the live book
        uint256 size = 100e6; // 100 contracts

        vm.prank(operator);
        vault.quote(0, MARKET, mid, half, size);

        // bid 0.485 + (1 - ask 0.515) = 0.485 + 0.485 = 0.97 per contract
        assertEq(vault.totalEscrowed(), 97e6, "pair cost is 1 - spread");
        assertEq(vault.idleAssets(), 500e6 - 97e6, "the rest stays idle");
        assertEq(vault.totalAssets(), 500e6, "NAV unchanged by quoting");
    }

    function test_bothLegsArePostOnlyAndCorrectlyPriced() public {
        _deposit(alice, 500e6);

        vm.prank(operator);
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), 100e6);

        assertEq(pool.placedCount(), 2, "two legs");

        MockPool.Placed memory yes = pool.placedAt(0);
        MockPool.Placed memory no = pool.placedAt(1);

        assertEq(yes.kind, ORDER_KIND.BUY_YES, "leg 1 buys YES");
        assertEq(no.kind, ORDER_KIND.BUY_NO, "leg 2 buys NO");
        assertEq(yes.price, 485_000, "bid 0.485");
        assertEq(no.price, 515_000, "ask 0.515, quoted YES-side");

        assertEq(yes.orderType, ORDER_TYPE.POST_ONLY, "must never take");
        assertEq(no.orderType, ORDER_TYPE.POST_ONLY, "must never take");

        assertEq(yes.expireTimestampNs, uint64(expiry) * 1e9, "expiry in ns, capped at the window");
        assertTrue(yes.expireTimestampNs != 0, "zero would revert as OrderAlreadyExpired");
    }

    function test_sizeIsQuantizedToTheLotGrid() public {
        _deposit(alice, 500e6);
        vm.prank(operator);
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), 100e6 + 7); // 7 wei above a lot boundary

        assertEq(pool.placedAt(0).quantity % LOT, 0, "on the lot grid");
        assertEq(pool.placedAt(0).quantity, 100e6, "floored, never rounded up");
    }

    function test_dustSizeIsRejectedRatherThanSentAsZero() public {
        _deposit(alice, 500e6);
        vm.prank(operator);
        vm.expectRevert(LiquidityVault.SizeFlooredToZero.selector);
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), LOT - 1);
    }

    function test_cannotQuoteMoreThanIdle() public {
        _deposit(alice, 10e6);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(LiquidityVault.InsufficientIdle.selector, 97e6, 10e6));
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), 100e6);
    }

    function test_spreadFloorStopsUsQuotingIntoAdverseSelection() public {
        _deposit(alice, 500e6);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(LiquidityVault.SpreadTooTight.selector, uint256(100)));
        vault.quote(0, MARKET, uint256(500_000), uint256(100), 100e6);
    }

    function test_slotCannotBeDoubleQuoted() public {
        _deposit(alice, 500e6);
        vm.startPrank(operator);
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), 100e6);
        vm.expectRevert(abi.encodeWithSelector(LiquidityVault.SlotBusy.selector, uint256(0)));
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), 100e6);
        vm.stopPrank();
    }

    function test_rejectedLegRevertsTheWholeQuote() public {
        _deposit(alice, 500e6);
        pool.setRejectNext(true);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(LiquidityVault.OrderRejected.selector, ORDER_KIND.BUY_YES));
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), 100e6);
        assertEq(vault.totalEscrowed(), 0, "no escrow committed on a failed quote");
    }

    // -------------------------------------------------------------- lifecycle

    function test_refusesAMarketThatIsNotTrading() public {
        _deposit(alice, 500e6);
        vm.warp(expiry + 1);
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(LiquidityVault.MarketNotTrading.selector, MARKET, MarketStatus.LOCKED)
        );
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), 100e6);
    }

    /// Headroom scales with the tier. A fixed 300s rule would reject the 60s and 300s
    /// tiers outright — two of the venue's six.
    function test_headroomScalesWithTheTier() public {
        _deposit(alice, 500e6);

        // 10% of a 900s window is 90s. At 100s left the quote is fine.
        vm.warp(expiry - 100);
        vm.prank(operator);
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), 100e6);

        // At 60s left it is inside the buffer.
        vm.warp(expiry - 60);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(LiquidityVault.NoHeadroom.selector, MARKET));
        vault.quote(1, MARKET, uint256(500_000), uint256(15_000), 100e6);
    }

    function test_cancelReturnsEscrowAndPullsBothLegs() public {
        _deposit(alice, 500e6);
        vm.startPrank(operator);
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), 100e6);
        vault.cancelQuote(0);
        vm.stopPrank();

        assertEq(vault.totalEscrowed(), 0, "escrow released");
        assertEq(pool.cancelledCount(), 2, "both legs pulled");
        assertFalse(vault.slots(0).active, "slot freed");
    }

    // ---------------------------------------------------------------- shares

    function test_sharesTrackNavAcrossTwoDepositors() public {
        _deposit(alice, 100e6);
        _deposit(bob, 300e6);

        assertEq(vault.totalAssets(), 400e6);
        assertEq(vault.convertToAssets(vault.balanceOf(alice)), 100e6, "alice keeps her quarter");
        assertEq(vault.convertToAssets(vault.balanceOf(bob)), 300e6, "bob keeps his three quarters");

        // Quoting moves collateral into escrow; it must not move share value.
        vm.prank(operator);
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), 100e6);
        assertEq(vault.convertToAssets(vault.balanceOf(alice)), 100e6, "NAV is idle + escrow");
    }

    function test_withdrawIsLimitedByIdleNotByNav() public {
        _deposit(alice, 500e6);
        vm.prank(operator);
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), 100e6); // 97 escrowed, 403 idle

        vm.prank(alice);
        vault.withdraw(403e6, alice, alice);
        assertEq(usdc.balanceOf(alice), 1_000e6 - 500e6 + 403e6, "idle is withdrawable");

        // The escrowed remainder cannot leave until the quote is cancelled.
        vm.prank(alice);
        vm.expectRevert();
        vault.withdraw(97e6, alice, alice);
    }

    // -------------------------------------------------------------- settlement

    function _quotedAndFilled() internal returns (uint256 escrow) {
        _deposit(alice, 500e6);
        vm.prank(operator);
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), 100e6);
        escrow = vault.totalEscrowed();
        // Both legs filled: the pool minted a pair, so the vault holds 100 YES + 100 NO.
        outcome.setBalance(address(vault), YES_ID, 100e6);
        outcome.setBalance(address(vault), NO_ID, 100e6);
    }

    /// The module PULLS outcome tokens on redemption, so the grant must exist from
    /// construction. Discovering it is missing at settlement time means capital is
    /// already stuck in a market that has left the live list.
    function test_moduleIsAnOperatorFromConstruction() public view {
        assertTrue(outcome.isOperator(address(vault), address(module)), "granted at deploy");
    }

    function test_cannotSettleAMarketThatIsStillLive() public {
        _quotedAndFilled();
        vm.expectRevert(
            abi.encodeWithSelector(LiquidityVault.MarketNotSettled.selector, MARKET, MarketStatus.TRADING)
        );
        vault.settle(0);
    }

    /// `winningOutcome()` was removed in settlement v3 and reverts. The winner is the
    /// argmax of the payout vector, and this pins that we read it that way.
    function test_redeemsTheArgmaxOfThePayoutVector() public {
        _quotedAndFilled();
        vm.warp(expiry + 1);
        market.resolve(0, 10_000_000); // NO wins

        uint256 navBefore = vault.totalAssets();
        uint256 redeemed = vault.settle(0);

        assertEq(redeemed, 100e6, "the winning side redeems 1:1");
        assertEq(outcome.balanceOf(address(vault), NO_ID), 0, "winning tokens consumed");
        assertEq(vault.totalEscrowed(), 0, "escrow released");
        assertFalse(vault.slots(0).active, "slot freed for reuse");
        // NAV does not jump here: the spread was recognised the moment the pair filled,
        // because a complete set is already worth exactly 1 per pair. Settlement only
        // converts it to collateral.
        assertEq(vault.totalAssets(), navBefore, "settlement realises, it does not create");
    }

    /// A void pays 0.5 on BOTH sides. Redeeming only the "winner" abandons half the
    /// position, and a void has no winner to find.
    function test_voidRedeemsBothSidesNotJustOne() public {
        _quotedAndFilled();
        vm.warp(expiry + 1);
        market.voidIt();

        uint256 redeemed = vault.settle(0);

        assertEq(redeemed, 100e6, "50 from each side, not 50 from one");
        assertEq(outcome.balanceOf(address(vault), YES_ID), 0, "YES redeemed");
        assertEq(outcome.balanceOf(address(vault), NO_ID), 0, "NO redeemed");
    }

    /// Deliberately callable by anyone: there is nothing to steal, proceeds go to the
    /// vault. Gating this behind the operator is how capital gets stranded when a key
    /// goes quiet, and a settled market leaves the live list so nothing will remind us.
    function test_settleIsPermissionlessAndPaysTheVaultNotTheCaller() public {
        _quotedAndFilled();
        vm.warp(expiry + 1);
        market.resolve(10_000_000, 0); // YES wins

        address stranger = address(0xBEEF);
        uint256 strangerBefore = usdc.balanceOf(stranger);

        vm.prank(stranger);
        uint256 redeemed = vault.settle(0);

        assertEq(redeemed, 100e6);
        assertEq(usdc.balanceOf(stranger), strangerBefore, "caller gains nothing");
        assertEq(vault.idleAssets(), 500e6 - 97e6 + 100e6, "proceeds land in the vault");
    }

    function test_settlingWithNoPositionReverts() public {
        _deposit(alice, 500e6);
        vm.prank(operator);
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), 100e6);
        vm.warp(expiry + 1);
        market.resolve(10_000_000, 0);
        // Never filled, so nothing to redeem — must say so rather than silently freeing.
        vm.expectRevert(abi.encodeWithSelector(LiquidityVault.NothingToRedeem.selector, MARKET));
        vault.settle(0);
    }

    function test_sharesAppreciateTheMomentThePairFills() public {
        _deposit(alice, 500e6);
        assertEq(vault.convertToAssets(vault.balanceOf(alice)), 500e6);

        vm.prank(operator);
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), 100e6);
        assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(alice)), 500e6, 1, "quoting alone earns nothing");

        // Both legs fill: the vault now holds a complete set worth 100 that cost 97.
        outcome.setBalance(address(vault), YES_ID, 100e6);
        outcome.setBalance(address(vault), NO_ID, 100e6);
        assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(alice)), 503e6, 1, "spread recognised at fill");

        vm.warp(expiry + 1);
        market.resolve(10_000_000, 0);
        vault.settle(0);
        assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(alice)), 503e6, 1, "settlement adds nothing new");
    }

    /// Share price is a transfer of value between users. If a filled position were still
    /// carried at cost, someone depositing between the fill and the settlement would buy
    /// in below true NAV and dilute everyone already there.
    function test_aLateDepositorCannotBuyInBelowTrueValue() public {
        _quotedAndFilled(); // alice paid 500, vault holds a set worth 100 that cost 97
        assertEq(vault.totalAssets(), 503e6, "NAV marks the complete set at its real worth");

        _deposit(bob, 503e6);
        // Bob paid 503 for what alice's 500 became. Neither is diluted.
        assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(alice)), 503e6, 2, "alice unharmed");
        assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(bob)), 503e6, 2, "bob paid fair value");
    }

    // ---------------------------------------------------------------- flatten

    /// A complete set is worth exactly 1 at any moment, so there is no reason to leave
    /// it idle until the window resolves. This is the whole point of flatten.
    function test_flattenRealisesTheSpreadWithoutWaitingForSettlement() public {
        _quotedAndFilled(); // paid 97, holds 100 YES + 100 NO

        vm.prank(operator);
        uint256 returned = vault.flatten(0);

        assertEq(returned, 100e6, "100 pairs merge to 100 collateral");
        assertEq(outcome.balanceOf(address(vault), YES_ID), 0, "sets consumed");
        assertEq(outcome.balanceOf(address(vault), NO_ID), 0);
        assertEq(vault.totalEscrowed(), 0, "escrow fully released");
        assertFalse(vault.slots(0).active, "slot freed to quote again");
        assertEq(vault.idleAssets(), 500e6 - 97e6 + 100e6, "capital back, spread realised");
    }

    /// Cancelling a live quote throws away the spread the vault exists to earn. An open
    /// version of this would let anyone grief the vault by closing good quotes on repeat.
    function test_strangerCannotFlattenALiveQuote() public {
        _quotedAndFilled();
        vm.prank(address(0xBEEF));
        vm.expectRevert(
            abi.encodeWithSelector(LiquidityVault.OnlyOperatorWhileTrading.selector, MARKET)
        );
        vault.flatten(0);
    }

    /// Past the point where the market can trade there is no fill left to lose, so
    /// capital must not sit behind a key that may have gone quiet.
    function test_anyoneCanFlattenOnceTheMarketCannotTrade() public {
        _quotedAndFilled();
        vm.warp(expiry + 1); // Locked

        vm.prank(address(0xBEEF));
        uint256 returned = vault.flatten(0);
        assertEq(returned, 100e6);
        assertEq(vault.idleAssets(), 500e6 - 97e6 + 100e6, "proceeds to the vault");
    }

    function test_flatteningWithNoCompleteSetReverts() public {
        _deposit(alice, 500e6);
        vm.prank(operator);
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), 100e6);
        // Only the YES leg filled: one side alone is not a set and still carries direction.
        outcome.setBalance(address(vault), YES_ID, 100e6);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(LiquidityVault.NothingToFlatten.selector, MARKET));
        vault.flatten(0);
    }

    /// An uneven fill leaves a leg that cannot be merged and still carries direction.
    /// That one has to wait for settlement, so the slot must stay open for it.
    function test_unevenFillMergesThePairAndKeepsTheSlotForTheRest() public {
        _deposit(alice, 500e6);
        vm.prank(operator);
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), 100e6);
        outcome.setBalance(address(vault), YES_ID, 100e6);
        outcome.setBalance(address(vault), NO_ID, 60e6);

        vm.prank(operator);
        uint256 returned = vault.flatten(0);

        assertEq(returned, 60e6, "only the matched pairs merge");
        assertEq(outcome.balanceOf(address(vault), YES_ID), 40e6, "naked leg remains");
        assertEq(outcome.balanceOf(address(vault), NO_ID), 0);
        assertTrue(vault.slots(0).active, "slot stays open so settle() can redeem the rest");
        assertGt(vault.totalEscrowed(), 0, "residual cost basis still carried");
    }

    function test_navIsContinuousAcrossFlatten() public {
        _quotedAndFilled();
        uint256 navBefore = vault.totalAssets();
        vm.prank(operator);
        vault.flatten(0);
        // Merging changes the FORM of the assets, not their worth. A jump either way
        // would mean one of the two states was mispriced.
        assertEq(vault.totalAssets(), navBefore, "form changed, value did not");
    }

    // ----------------------------------------------------- keeper-free sweep

    address constant PRECOMPILE = SomniaExtensions.SOMNIA_REACTIVITY_PRECOMPILE_ADDRESS;

    /// Drives the callback exactly as the precompile would.
    function roller_onEvent(uint256 whenMs) internal {
        bytes32[] memory topics = new bytes32[](2);
        topics[0] = ISomniaTicks.Schedule.selector;
        topics[1] = bytes32(whenMs);
        vm.prank(PRECOMPILE);
        vault.onEvent(PRECOMPILE, topics, "");
    }

    /// The window is over, nobody called anything, and the vault let its own capital go.
    /// That is the whole point of arming: a dead quote earns nothing and its escrow is
    /// stuck until something cancels it, so the something is the chain.
    function test_sweepReleasesCapitalWithNobodyCallingIt() public {
        _quotedAndFilled();
        assertEq(vault.totalEscrowed(), 97e6);

        vm.warp(expiry + 1); // window locked
        roller_onEvent(uint256(expiry + 1) * 1000);

        assertEq(vault.totalEscrowed(), 0, "escrow released");
        assertFalse(vault.slots(0).active, "slot freed");
        assertEq(vault.idleAssets(), 500e6 - 97e6 + 100e6, "complete set merged back");
    }

    /// A slot still earning must not be touched. Cancelling a live quote throws away the
    /// spread the vault exists to collect.
    function test_sweepLeavesALiveQuoteAlone() public {
        _quotedAndFilled();
        roller_onEvent(uint256(block.timestamp) * 1000); // still Trading
        assertEq(vault.totalEscrowed(), 97e6, "untouched");
        assertTrue(vault.slots(0).active);
    }

    /// A reactivity callback that reverts is LOST — no retry, no error surface. One bad
    /// slot must not take the others down with it.
    function test_oneFailingSlotDoesNotStopTheSweep() public {
        _deposit(alice, 500e6);
        vm.startPrank(operator);
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), 100e6);
        vault.quote(1, MARKET, uint256(500_000), uint256(15_000), 100e6);
        vm.stopPrank();

        // Slot 0 filled cleanly; slot 1 is uneven and cannot fully close.
        outcome.setBalance(address(vault), YES_ID, 100e6);
        outcome.setBalance(address(vault), NO_ID, 100e6);

        vm.warp(expiry + 1);
        roller_onEvent(uint256(expiry + 1) * 1000);

        assertFalse(vault.slots(0).active, "clean slot closed");
        // The sweep completed rather than reverting on the awkward one.
        assertEq(vault.totalEscrowed() < 194e6, true, "at least one slot released");
    }

    function test_onlyThePrecompileCanTriggerASweep() public {
        _quotedAndFilled();
        vm.warp(expiry + 1);
        bytes32[] memory topics = new bytes32[](2);
        topics[0] = ISomniaTicks.Schedule.selector;
        topics[1] = bytes32(uint256(expiry + 1) * 1000);

        vm.prank(operator);
        vm.expectRevert(); // OnlyReactivityPrecompile from the Somnia base
        vault.onEvent(PRECOMPILE, topics, "");
    }

    function test_armingRefusesWhenTheHandlerIsUnderfunded() public {
        // The precompile requires 32 STT and answers an underfunded handler with empty
        // revert data. The vault names the problem instead.
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(AbadiReactive.Underfunded.selector, uint256(0), 32 ether));
        vault.armSweep(uint64(block.timestamp + 600));
    }

    function test_onlyOperatorCanArm() public {
        vm.deal(address(vault), 33 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LiquidityVault.NotOperator.selector, alice));
        vault.armSweep(uint64(block.timestamp + 600));
    }
}

interface ISomniaTicks {
    event Schedule(uint256 indexed timestampMillis);
}
