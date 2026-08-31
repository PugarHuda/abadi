// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {LiquidityVault} from "../src/LiquidityVault.sol";
import {MarketEngine} from "../src/MarketEngine.sol";
import {IBinaryMarketsModule, MarketStatus} from "../src/interfaces/IBinaryMarketsModule.sol";
import {PoolOrder, IOutcomeToken6909, ORDER_KIND, ORDER_TYPE} from "../src/interfaces/IBinaryPool.sol";
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
    /// @dev Collateral the pool is still holding for a resting order. A mock that forgets
    ///      to hand it back on cancel makes stranded escrow invisible.
    mapping(uint128 => uint256) public escrowOf;
    mapping(uint128 => bool) public filled;

    error IncorrectSender(address caller, address owner);
    error Paused();
    bool public paused;

    /// @dev The venue freezes a pool's whole book the moment its window expires, and keeps
    ///      it frozen until the market goes terminal: on Shannon `cancelOrder`,
    ///      `cancelOrders`, `cancelExpiredOrders` and `sweepExpiredAtLevel` all answer the
    ///      same undecodable 0x8afbce93 in that gap, and all four start working again once
    ///      the market is voided or resolved. A mock that let cancels through there is why
    ///      the sweep shipped as a no-op on the one shape it exists for.
    MockMarket public gate;
    uint64 public frozenFrom;

    function setFreeze(MockMarket gate_, uint64 from) external {
        gate = gate_;
        frozenFrom = from;
    }

    error BookFrozen();

    function frozen() public view returns (bool) {
        if (frozenFrom == 0 || block.timestamp < frozenFrom) return false;
        return !gate.isResolved() && !gate.isVoided();
    }

    function setPaused(bool v) external {
        paused = v;
    }

    /// @dev Contracts still resting under an id. The real pool keeps this and it is the
    ///      only authoritative answer to "how much of this leg has not filled" — a
    ///      balance read cannot tell a fill from a merge or from a stranger's donation.
    mapping(uint128 => uint256) public remainingOf;

    error IncorrectOrder();

    /// @dev Mirrors the venue: REVERTS for an id with no active order behind it, rather
    ///      than returning a zeroed struct. Callers read that revert as "nothing resting".
    ///      The freeze gates WRITES to the book, not reads: measured against the real
    ///      pool on two expired-and-unresolved markets, `getOrder` answered normally
    ///      while every cancel path reverted.
    function getOrder(uint128 orderId) external view returns (PoolOrder memory o) {
        if (orderId == 0 || remainingOf[orderId] == 0) revert IncorrectOrder();
        o.orderId = orderId;
        o.owner = address(this);
        o.quantityRemaining = remainingOf[orderId];
        o.fullQuantity = remainingOf[orderId];
    }

    /// @dev Take `spent` of an order's escrow, as a fill does. An order whose escrow is
    ///      used up stops being a live order the vault owns.
    function fillPartial(uint128 orderId, uint256 spent) public {
        uint256 had = escrowOf[orderId];
        escrowOf[orderId] -= spent;
        if (had > 0) remainingOf[orderId] = (remainingOf[orderId] * escrowOf[orderId]) / had;
        if (escrowOf[orderId] == 0) { filled[orderId] = true; remainingOf[orderId] = 0; }
    }

    function fill(uint128 orderId) external {
        fillPartial(orderId, escrowOf[orderId]);
    }

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
        escrowOf[id] = cost;
        remainingOf[id] = quantity;
        success = true;
    }

    /// @dev The real pool reverts `IncorrectSender` on an id that is no longer the
    ///      caller's live order, which is exactly what a filled leg looks like. A mock
    ///      that always succeeded is why the vault shipped with an exit that bricks on
    ///      the one shape that needs it.
    function cancelOrder(uint128 orderId) external {
        if (paused) revert Paused();
        if (frozen()) revert BookFrozen();
        if (filled[orderId]) revert IncorrectSender(msg.sender, address(this));
        cancelled.push(orderId);
        uint256 back = escrowOf[orderId];
        escrowOf[orderId] = 0;
        remainingOf[orderId] = 0;
        if (back > 0) collateral.transfer(msg.sender, back);
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

    /// @dev Shannon's binary windows give the oracle 300s past expiry; after that
    ///      `voidExpired` opens to anyone.
    uint64 public expiry;
    uint64 public settlementWindow = 300;

    error SettlementWindowOpen();

    function setExpiry(uint64 e) external {
        expiry = e;
    }

    function setSettlementWindow(uint64 w) external {
        settlementWindow = w;
    }

    /// @notice The dead-oracle hatch, gated on the clock exactly as the venue gates it.
    function voidExpired() external {
        if (isResolved || isVoided) return;
        if (block.timestamp < uint256(expiry) + settlementWindow) revert SettlementWindowOpen();
        isVoided = true;
        _payouts = [5, 5];
    }

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

    /// @dev Both are permissionless no-op-guarded keeper entries on the real module. They
    ///      are modelled as counters rather than no-ops so a test can assert the sweep
    ///      actually drives them: a market voided through the hatch bypasses the module,
    ///      and redemption finds an empty settlement until both have run.
    mapping(bytes32 => uint256) public synced;
    mapping(bytes32 => uint256) public finalizedCount;

    function syncSettlement(bytes32 marketId) external {
        Rec memory r = recs[marketId];
        require(MockMarket(r.market).isResolved() || MockMarket(r.market).isVoided(), "MarketNotSettled");
        synced[marketId]++;
    }

    function finalizeMarket(bytes32 marketId) external {
        finalizedCount[marketId]++;
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
    /// A second window on the same pool. One market may only occupy one slot, so any
    /// test that wants two live slots needs two windows.
    bytes32 constant MARKET2 = bytes32(uint256(0xB7D));
    uint256 constant YES2_ID = 333;
    uint256 constant NO2_ID = 444;
    MockMarket market2;

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
        market.setExpiry(expiry);
        module.set(MARKET, address(pool), tradingStart, expiry);
        module.setSettlement(MARKET, address(market), YES_ID, NO_ID);
        market2 = new MockMarket();
        market2.setExpiry(expiry);
        module.set(MARKET2, address(pool), tradingStart, expiry);
        module.setSettlement(MARKET2, address(market2), YES2_ID, NO2_ID);
        // Both windows share the pool and expire together, so one gate covers the book.
        pool.setFreeze(market, expiry);
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

    /// The reactivity floor is 32 STT held by this contract. A contract that must hold
    /// that much needs an exit by construction — three probes on Shannon did not have one.
    function test_governorCanRecoverTheNativeReserveAndNobodyElseCan() public {
        vm.deal(address(vault), 32 ether);

        vm.prank(operator);
        vm.expectRevert();
        vault.sweepNative(payable(operator), 1 ether);
        vm.prank(alice);
        vm.expectRevert();
        vault.sweepNative(payable(alice), 1 ether);

        address payable treasury = payable(address(0x7777));
        vm.prank(governor);
        vault.sweepNative(treasury, 32 ether);
        assertEq(treasury.balance, 32 ether, "the reserve came back out");
        assertEq(address(vault).balance, 0);
    }

    /// Native currency and collateral are different money. Moving the gas reserve must
    /// not be able to touch what depositors put in.
    function test_sweepingNativeLeavesCollateralAlone() public {
        _deposit(alice, 500e6);
        vm.deal(address(vault), 5 ether);
        vm.prank(governor);
        vault.sweepNative(payable(governor), 5 ether);
        assertEq(vault.totalAssets(), 500e6, "collateral untouched");
        assertEq(usdc.balanceOf(address(vault)), 500e6);
    }

    /// Redeeming the last share while a slot is open hands that slot's proceeds to the
    /// virtual share forever. Measured on Shannon: 102.13 tUSDC, unrecoverable.
    function test_theLastShareCannotLeaveWhileASlotIsOpen() public {
        _deposit(alice, 500e6);
        vm.prank(operator);
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), 100e6);

        uint256 all = vault.balanceOf(alice);
        vm.prank(alice);
        // The guard is enforced twice over: `maxRedeem` reports the real ceiling, so
        // ERC-4626 refuses before `_withdraw` is reached. Both are the same rule.
        vm.expectRevert();
        vault.redeem(all, alice, alice);

        // Anyone who is not the last share is unaffected.
        _deposit(bob, 100e6);
        vm.prank(alice);
        vault.redeem(all, alice, alice);
        assertEq(vault.balanceOf(alice), 0, "alice could leave once she was not last");

        // And the last share leaves the moment the slot is closed.
        vm.prank(operator);
        vault.cancelQuote(0);
        uint256 bobs = vault.balanceOf(bob);
        vm.prank(bob);
        vault.redeem(bobs, bob, bob);
        assertEq(vault.totalSupply(), 0);
    }

    /// Outcome balances are per market on the 6909, not per slot. Two slots on one window
    /// would each see the other's fills; the fuzzer showed the escrow derivation and the
    /// pair count both breaking. One market, one slot.
    function test_aMarketCannotBeQuotedInTwoSlots() public {
        _deposit(alice, 500e6);
        vm.startPrank(operator);
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), 100e6);
        vm.expectRevert(abi.encodeWithSelector(LiquidityVault.MarketAlreadyQuoted.selector, MARKET, 0));
        vault.quote(1, MARKET, uint256(500_000), uint256(15_000), 100e6);
        // Once the first slot is gone the market is quotable again.
        vault.cancelQuote(0);
        vault.quote(1, MARKET, uint256(500_000), uint256(15_000), 100e6);
        vm.stopPrank();
        assertTrue(vault.slots(1).active);
    }

    /// A cancel that fails for any reason other than "already gone" must stop the
    /// exit, not be shrugged off. Shrugging deleted a slot on Shannon whose legs were
    /// still live; they filled later and 200 tokens appeared under a 100-contract slot.
    function test_aCancelThatFailsForAnotherReasonAbortsTheExit() public {
        _deposit(alice, 500e6);
        vm.prank(operator);
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), 100e6);

        pool.setPaused(true);
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(LiquidityVault.CancelFailed.selector, 1, abi.encodeWithSelector(MockPool.Paused.selector))
        );
        vault.cancelQuote(0);
        assertTrue(vault.slots(0).active, "the slot is still owned, because the orders are still live");

        pool.setPaused(false);
        vm.prank(operator);
        vault.cancelQuote(0);
        assertFalse(vault.slots(0).active);
        assertEq(vault.idleAssets(), 500e6, "and the escrow came back");
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
        vm.expectRevert(abi.encodeWithSelector(LiquidityVault.NoHeadroom.selector, MARKET2));
        vault.quote(1, MARKET2, uint256(500_000), uint256(15_000), 100e6);
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
        // Both ids stop being live orders, which is what makes them uncancellable.
        outcome.setBalance(address(vault), YES_ID, 100e6);
        outcome.setBalance(address(vault), NO_ID, 100e6);
        pool.fill(1);
        pool.fill(2);
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

    /// A window that resolved with neither leg taken still has both orders resting on a
    /// pool that will never fill them. Settling has to pull them, or the escrow behind a
    /// dead quote is gone for as long as the pool lives.
    function test_settlingAnUnfilledSlotPullsTheRestingLegsAndReturnsTheEscrow() public {
        _deposit(alice, 500e6);
        vm.prank(operator);
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), 100e6);
        assertEq(vault.idleAssets(), 500e6 - 97e6, "escrow left the vault at placement");

        vm.warp(expiry + 1);
        market.resolve(10_000_000, 0);

        uint256 redeemed = vault.settle(0);
        assertEq(redeemed, 0, "nothing was held, so nothing redeems");
        assertEq(vault.idleAssets(), 500e6, "every cent of escrow came back");
        assertFalse(vault.slots(0).active, "the slot is free to quote again");
        assertEq(vault.totalEscrowed(), 0);
    }

    /// The shape that bricked the live vault: one leg fills, the market resolves against
    /// it, and the slot holds only losing tokens. `flatten` refuses it for want of a pair
    /// and the filled leg cannot be cancelled, so if `settle` also refuses there is no
    /// way out at all and NAV keeps quoting capital that is gone.
    function test_settlingASlotHoldingOnlyTheLosingSideStillClearsIt() public {
        _deposit(alice, 500e6);
        vm.prank(operator);
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), 100e6);

        // The BUY_NO leg is taken; the BUY_YES leg never is.
        outcome.setBalance(address(vault), NO_ID, 100e6);
        pool.fill(2);

        vm.warp(expiry + 1);
        market.resolve(10_000_000, 0); // YES wins, so the held NO is worth zero

        uint256 redeemed = vault.settle(0);
        assertEq(redeemed, 0, "the losing side redeems nothing");
        assertFalse(vault.slots(0).active, "and the slot must not stay stuck");
        assertEq(vault.totalEscrowed(), 0, "no phantom escrow left behind");
        // The unfilled BUY_YES leg's escrow is recovered; the filled BUY_NO leg's is lost.
        assertEq(vault.idleAssets(), 500e6 - 48_500_000, "only the leg that traded is spent");
    }

    /// `cancelQuote` cancelled both stored ids unconditionally. Once one leg fills, that
    /// id is dead and the pool reverts on it — bricking the exit for precisely the slot
    /// that has directional exposure to close.
    function test_cancelQuoteSurvivesALegThatAlreadyFilled() public {
        _deposit(alice, 500e6);
        vm.prank(operator);
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), 100e6);

        outcome.setBalance(address(vault), NO_ID, 100e6);
        pool.fill(2);

        vm.prank(operator);
        vault.cancelQuote(0);

        assertEq(vault.idleAssets(), 500e6 - 48_500_000, "the live leg's escrow came back");
        assertEq(vault.totalEscrowed(), 0, "nothing is resting any more");
        // The 100 NO it already bought is still there, so the slot has to be.
        assertTrue(vault.slots(0).active, "a slot holding tokens stays open for settle()");
    }

    /// Cancelling pulls the orders. It does not pull what they already bought, and the
    /// only function that can redeem those is `settle`, which needs the slot to exist.
    function test_cancelQuoteDoesNotOrphanTokensTheSlotAlreadyHolds() public {
        _deposit(alice, 500e6);
        vm.prank(operator);
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), 100e6);
        outcome.setBalance(address(vault), NO_ID, 100e6);
        pool.fill(2);

        vm.prank(operator);
        vault.cancelQuote(0);

        // The market goes the other way: the side that looked dead is the side that pays.
        vm.warp(expiry + 1);
        market.resolve(0, 10_000_000); // NO wins

        uint256 redeemed = vault.settle(0);
        assertEq(redeemed, 100e6, "the cancelled slot could still be redeemed");
        assertFalse(vault.slots(0).active);
    }

    /// With nothing bought, there is nothing to keep the slot open for.
    function test_cancelQuoteFreesASlotThatBoughtNothing() public {
        _deposit(alice, 500e6);
        vm.prank(operator);
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), 100e6);

        vm.prank(operator);
        vault.cancelQuote(0);

        assertFalse(vault.slots(0).active, "slot is free to quote again");
        assertEq(vault.idleAssets(), 500e6, "all of it came back");
    }

    /// NAV priced a directional leg at what it cost. A depositor arriving after an adverse
    /// one-sided fill would have bought shares against collateral that no longer existed,
    /// and the loss would have been split with them.
    function test_aNakedLegIsWorthNothingUntilSettlement() public {
        _deposit(alice, 500e6);
        vm.prank(operator);
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), 100e6);
        assertApproxEqAbs(vault.totalAssets(), 500e6, 1, "resting on both sides is still cash");

        // Only the BUY_NO leg fills: 47 of collateral becomes 100 directional tokens.
        outcome.setBalance(address(vault), NO_ID, 100e6);
        pool.fill(2);

        assertEq(vault.totalAssets(), 500e6 - 48_500_000, "the 48.5 it cost is not an asset any more");
        assertEq(vault.totalEscrowed(), 48_500_000, "only the leg still resting holds escrow");

        // The partner arrives; now it is a complete set and worth exactly its size.
        outcome.setBalance(address(vault), YES_ID, 100e6);
        pool.fill(1);
        assertEq(vault.totalAssets(), 500e6 - 97e6 + 100e6, "a pair settles at one apiece");
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
        pool.fill(1);
        pool.fill(2);
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
        // The BUY_YES leg is taken whole; the BUY_NO leg only 60 of its 100, so 40%
        // of its escrow is still resting and has to come back.
        outcome.setBalance(address(vault), YES_ID, 100e6);
        outcome.setBalance(address(vault), NO_ID, 60e6);
        pool.fill(1);
        pool.fillPartial(2, (48_500_000 * 60) / 100);

        vm.prank(operator);
        uint256 returned = vault.flatten(0);

        assertEq(returned, 60e6, "only the matched pairs merge");
        assertEq(outcome.balanceOf(address(vault), YES_ID), 40e6, "naked leg remains");
        assertEq(outcome.balanceOf(address(vault), NO_ID), 0);
        assertTrue(vault.slots(0).active, "slot stays open so settle() can redeem the rest");
        assertEq(vault.totalEscrowed(), 0, "both legs were pulled, so nothing is resting");
        // 403 idle + 19.4 of unspent BUY_NO escrow returned + 60 merged. The 40 naked YES
        // is carried at nothing, because until settlement that is all it is worth.
        assertEq(vault.totalAssets(), 403e6 + 19_400_000 + 60e6, "the naked leg is carried at nothing");
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
        // Both legs took, so nothing is resting any more — the 97 became a complete set.
        assertEq(vault.totalEscrowed(), 0);
        assertEq(vault.totalAssets(), 503e6);

        // The wake-up is armed past the oracle's window, not 45s past the market's. Inside
        // that window there is nothing the vault can do and nothing it should pretend to.
        vm.warp(uint256(expiry) + market.settlementWindow() + 15);
        roller_onEvent(block.timestamp * 1000);

        assertEq(vault.totalEscrowed(), 0, "escrow released");
        assertFalse(vault.slots(0).active, "slot freed");
        assertEq(vault.idleAssets(), 500e6 - 97e6 + 100e6, "complete set redeemed back");
    }

    /// The shape that froze 196 of this vault's capital for two days on Shannon: a window
    /// expires, the oracle never answers, and every keeper entry the venue offers refuses.
    /// The market's own hatch is the way out, and the sweep is what takes it.
    function test_sweepVoidsAWindowTheOracleAbandoned() public {
        _deposit(alice, 500e6);
        vm.prank(operator);
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), 100e6);
        assertEq(vault.totalEscrowed(), 97e6, "both legs resting");

        // Past expiry the pool freezes its book: nothing can fill, nothing can cancel.
        vm.warp(expiry + 1);
        assertTrue(pool.frozen(), "book frozen in the gap");
        vm.expectRevert(MockMarket.SettlementWindowOpen.selector);
        market.voidExpired();

        vm.warp(uint256(expiry) + market.settlementWindow() + 15);
        roller_onEvent(block.timestamp * 1000);

        assertTrue(market.isVoided(), "the sweep took the hatch");
        // The callback deliberately does NOT drive syncSettlement/finalizeMarket. Measured
        // on a fork against the real module, redemption after a bare voidExpired returns
        // the full amount without them, and they cost 3.94M of gas the callback pays for
        // out of the balance that keeps it able to arm at all. The bot still makes both.
        assertEq(module.synced(MARKET), 0, "the sweep does not pay for the hub nudge");
        assertEq(module.finalizedCount(MARKET), 0, "nor for finalize");
        assertFalse(vault.slots(0).active, "slot freed");
        assertEq(vault.totalEscrowed(), 0, "escrow no longer counted");
        assertEq(vault.idleAssets(), 500e6, "every cent of the escrow came back");
    }

    /// Between expiry and settlement the honest answer is "not yet". What must never
    /// happen is the vault clearing an order id the pool is still holding escrow under.
    function test_sweepInTheGapKeepsTheSlotAndWhatIsOwedOnIt() public {
        _deposit(alice, 500e6);
        vm.prank(operator);
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), 100e6);

        vm.warp(expiry + 1); // expired, oracle still has its window
        roller_onEvent(block.timestamp * 1000);

        assertTrue(vault.slots(0).active, "slot kept");
        assertTrue(vault.slots(0).yesOrderId != 0, "the pool is still holding this leg");
        assertEq(vault.totalEscrowed(), 97e6, "and the vault still says so");
        assertEq(vault.totalAssets(), 500e6, "nothing invented, nothing lost");
    }

    /// A slot still earning must not be touched. Cancelling a live quote throws away the
    /// spread the vault exists to collect.
    function test_sweepLeavesALiveQuoteAlone() public {
        _quotedAndFilled();
        roller_onEvent(uint256(block.timestamp) * 1000); // still Trading
        assertEq(vault.totalAssets(), 503e6, "untouched");
        assertTrue(vault.slots(0).active);
    }

    /// The lifecycle closing with nobody calling it: the window resolves, the wake-up
    /// fires, and the sweep redeems the position rather than just pulling the legs.
    function test_sweepSettlesASlotWhoseMarketHasResolved() public {
        _quotedAndFilled();
        vm.warp(expiry + 1);
        market.resolve(10_000_000, 0); // YES wins

        roller_onEvent(uint256(expiry + 1) * 1000);

        assertFalse(vault.slots(0).active, "settled by the sweep");
        assertEq(vault.idleAssets(), 500e6 - 97e6 + 100e6, "the 100 came back as cash");
        assertEq(vault.totalAssets(), 503e6);
    }

    // ------------------------------------------------- regressions for the 2026-08-30 audit

    /// The escrow derivation inferred "how much of this leg is unfilled" from the vault's
    /// ERC-6909 balance. `mergeCompleteSet` burns that balance, so a leg that had filled
    /// in full read back as never filled and its escrow was added a second time, on top of
    /// the cash the merge had just delivered. Reported assets 600 against 503 of real cash,
    /// and a holder able to redeem the difference.
    function test_flattenInTheFrozenGapDoesNotInventEscrow() public {
        _deposit(alice, 500e6);
        vm.prank(operator);
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), 100e6);

        pool.fill(1);
        pool.fill(2);
        outcome.setBalance(address(vault), YES_ID, 100e6);
        outcome.setBalance(address(vault), NO_ID, 100e6);

        vm.warp(expiry + 1);
        assertTrue(pool.frozen(), "the venue freezes the book at expiry");

        vm.prank(operator);
        vault.flatten(0);

        uint256 cash = usdc.balanceOf(address(vault));
        assertEq(cash, 503e6, "the merge delivered the set");
        assertEq(vault.totalEscrowed(), _poolLedger(), "escrow matches what the pool holds");
        assertEq(vault.totalAssets(), cash, "nothing invented on top of the cash");
        assertLe(vault.convertToAssets(vault.balanceOf(alice)), cash, "cannot redeem more than exists");
    }

    /// The pool's own ledger, summed exactly as invariant_restingEscrowMatchesThePoolsOwnLedger does.
    function _poolLedger() internal view returns (uint256 total) {
        for (uint256 i = 0; i < vault.MAX_SLOTS(); i++) {
            LiquidityVault.Slot memory s = vault.slots(i);
            if (!s.active) continue;
            if (s.yesOrderId != 0) total += pool.escrowOf(s.yesOrderId);
            if (s.noOrderId != 0) total += pool.escrowOf(s.noOrderId);
        }
    }

    /// Settlement v3 stores a payout VECTOR, not a winner. Taking its argmax abandoned the
    /// smaller side of a split, and on a tie picked index 0 and abandoned the other side
    /// entirely — with the slot already deleted, so nothing could come back for it.
    function test_aTiedPayoutVectorRedeemsBothSides() public {
        _quotedAndFilled();
        vm.warp(expiry + 1);
        market.resolve(5_000_000, 5_000_000); // a tie, and NOT voided

        uint256 before = vault.idleAssets();
        vault.settle(0);

        assertEq(vault.idleAssets() - before, 200e6, "both sides redeemed, not just one");
        assertFalse(vault.slots(0).active, "slot closed");
    }

    function test_aSplitPayoutVectorRedeemsBothSides() public {
        _quotedAndFilled();
        vm.warp(expiry + 1);
        market.resolve(7_000_000, 3_000_000);

        uint256 before = vault.idleAssets();
        vault.settle(0);
        assertEq(vault.idleAssets() - before, 200e6, "the 30% side was not abandoned");
    }

    /// One wei left behind defeated the last-share guard: the holder was no longer "the
    /// last share" and could exit in full at a NAV that marks the open leg at zero,
    /// leaving the slot's proceeds to the dust.
    function test_aDustHolderCannotBeLeftHoldingAnOpenSlot() public {
        _deposit(alice, 500e6);
        vm.prank(operator);
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), 100e6);

        // alice leaves a wei with someone else, then tries to take everything else.
        vm.prank(alice);
        vault.transfer(bob, 1);

        uint256 rest = vault.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert();
        vault.redeem(rest, alice, alice);

        // And the ceiling it does report always leaves the floor standing.
        uint256 max = vault.maxRedeem(alice);
        assertLt(max, rest, "cannot take everything while a slot is open");
        assertGe(vault.totalSupply() - max, vault.MIN_SUPPLY_WHILE_OPEN(), "the floor survives");
        vm.prank(alice);
        vault.redeem(max, alice, alice); // and what it reports must not revert
    }

    /// A first deposit of one wei plus a donation rounded the next depositor's shares to
    /// zero. OpenZeppelin's virtual-share defence scales with the decimals offset, and the
    /// default of 0 is not enough at six-decimal collateral.
    function test_theFirstDepositorCannotBeInflatedOut() public {
        usdc.mint(bob, 1_000e6);
        vm.startPrank(bob);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(1, bob); // one wei of shares
        usdc.transfer(address(vault), 1_000e6); // donate, to move the mark
        vm.stopPrank();

        _deposit(alice, 500e6);
        assertGt(vault.balanceOf(alice), 0, "the victim's deposit must mint something");
        assertGt(vault.convertToAssets(vault.balanceOf(alice)), 499e6, "and be worth about what it cost");
    }

    /// ERC-4626 requires these to report an amount that does not revert. A withdrawal is
    /// paid out of idle collateral, not NAV, and the app's Max button trusted the
    /// inherited answer and sent transactions that could only fail.
    function test_maxWithdrawIsCappedByIdleNotNav() public {
        _quotedAndFilled();
        assertLe(vault.maxWithdraw(alice), vault.idleAssets(), "never promises more than is there");
        uint256 max = vault.maxWithdraw(alice);
        vm.prank(alice);
        vault.withdraw(max, alice, alice); // must not revert
    }

    /// Governance surface. Neither setter had any test at all, including for who may call.
    function test_onlyGovernorCanSetRiskParams() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(LiquidityVault.NotGovernor.selector, operator));
        vault.setRiskParams(2000, 1);
        vm.prank(governor);
        vault.setRiskParams(2000, 20_000);
        assertEq(vault.headroomBps(), 2000);
        assertEq(vault.minHalfSpread(), 20_000);
    }

    function test_onlyGovernorCanSetGrid() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(LiquidityVault.NotGovernor.selector, operator));
        vault.setGrid(1e3, 1e3);
        vm.prank(governor);
        vault.setGrid(2e3, 2e3);
        assertEq(vault.tickSize(), 2e3);
        assertEq(vault.lotSize(), 2e3);
    }

    /// The guard that survives every other test: a cancel the pool refuses must leave the
    /// order id in place. Clearing it is how a freed slot kept two live legs on Shannon and
    /// 200 outcome tokens turned up under a slot that had quoted 100.
    function test_aRefusedCancelKeepsTheOrderId() public {
        _deposit(alice, 500e6);
        vm.prank(operator);
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), 100e6);
        pool.fill(1);
        outcome.setBalance(address(vault), YES_ID, 100e6);

        vm.warp(expiry + 1); // book frozen: the resting NO leg cannot be cancelled
        vm.prank(operator);
        vault.cancelQuote(0);

        assertTrue(vault.slots(0).active, "slot kept");
        assertTrue(vault.slots(0).noOrderId != 0, "the pool is still holding this leg");
        assertEq(vault.totalEscrowed(), _poolLedger(), "and the vault still says so");
    }

    /// The per-slot self-call is the sweep's isolation boundary. It must not be a door.
    function test_releaseSlotIsOnlyCallableByTheVaultItself() public {
        _quotedAndFilled();
        vm.expectRevert(abi.encodeWithSelector(LiquidityVault.NotSelf.selector, operator));
        vm.prank(operator);
        vault.releaseSlot(0);
    }

    /// A reactivity callback that reverts is LOST — no retry, no error surface. One bad
    /// slot must not take the others down with it.
    function test_oneFailingSlotDoesNotStopTheSweep() public {
        _deposit(alice, 500e6);
        vm.startPrank(operator);
        vault.quote(0, MARKET, uint256(500_000), uint256(15_000), 100e6);
        vault.quote(1, MARKET2, uint256(500_000), uint256(15_000), 100e6);
        vm.stopPrank();

        // Slot 0 filled cleanly; slot 1 is uneven and cannot fully close.
        outcome.setBalance(address(vault), YES_ID, 100e6);
        outcome.setBalance(address(vault), NO_ID, 100e6);
        outcome.setBalance(address(vault), YES2_ID, 100e6);
        pool.fill(3);

        // Slot 0's window can be voided; slot 1's oracle still has a week to answer, so
        // its hatch is shut and the sweep can do nothing with it. It must still finish.
        market2.setSettlementWindow(7 days);

        vm.warp(uint256(expiry) + market.settlementWindow() + 15);
        roller_onEvent(block.timestamp * 1000);

        assertFalse(vault.slots(0).active, "clean slot closed");
        assertTrue(vault.slots(1).active, "the awkward one is still there, untouched");
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
    // ------------------------------------------------------- governance handover

    /// A single-step transfer to a mistyped address hands the operator seat to nobody,
    /// permanently. Slither wanted `governor` immutable, which has the same effect the
    /// first time a key is lost — so the answer is a transfer path, not a constant.
    function test_governanceHandoverNeedsBothSides() public {
        vm.prank(governor);
        vault.transferGovernance(bob);

        assertEq(vault.governor(), governor, "not handed over until accepted");
        assertEq(vault.pendingGovernor(), bob);

        // The old governor still governs in the meantime.
        vm.prank(governor);
        vault.setOperator(address(0xFEE));
        assertEq(vault.operator(), address(0xFEE));

        vm.prank(bob);
        vault.acceptGovernance();
        assertEq(vault.governor(), bob);
        assertEq(vault.pendingGovernor(), address(0), "nomination consumed");
    }

    function test_onlyTheNomineeCanAccept() public {
        vm.prank(governor);
        vault.transferGovernance(bob);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LiquidityVault.NotPendingGovernor.selector, alice));
        vault.acceptGovernance();
    }

    function test_theOldGovernorLosesPowerOnHandover() public {
        vm.prank(governor);
        vault.transferGovernance(bob);
        vm.prank(bob);
        vault.acceptGovernance();

        vm.prank(governor);
        vm.expectRevert(abi.encodeWithSelector(LiquidityVault.NotGovernor.selector, governor));
        vault.setOperator(alice);
    }

    /// The module pulls outcome tokens on redemption. A token answering false instead of
    /// reverting would leave the vault able to buy positions and unable to redeem them —
    /// discovered at settlement, which is far too late.
    function test_deploymentFailsLoudlyIfTheOperatorGrantIsRefused() public {
        RefusingOutcome bad = new RefusingOutcome();
        vm.expectRevert(LiquidityVault.OperatorGrantFailed.selector);
        new LiquidityVault(
            IERC20(address(usdc)),
            IBinaryMarketsModule(address(module)),
            IOutcomeToken6909(address(bad)),
            governor,
            TICK,
            LOT
        );
    }
}

interface ISomniaTicks {
    event Schedule(uint256 indexed timestampMillis);
}

/// An ERC-6909 that reports failure rather than reverting.
contract RefusingOutcome {
    function setOperator(address, bool) external pure returns (bool) {
        return false;
    }

    function balanceOf(address, uint256) external pure returns (uint256) {
        return 0;
    }

    function isOperator(address, address) external pure returns (bool) {
        return false;
    }
}
