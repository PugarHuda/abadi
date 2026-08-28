// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LiquidityVault} from "../src/LiquidityVault.sol";
import {IBinaryMarketsModule} from "../src/interfaces/IBinaryMarketsModule.sol";
import {IOutcomeToken6909} from "../src/interfaces/IBinaryPool.sol";
import {MockUSDC, MockPool, MockOutcome6909, MockMarket, MockModule} from "./LiquidityVault.t.sol";

/// @dev Drives the vault through every path a window can take, in random order: deposits,
///      quotes, fills of either leg, cancels, flattens, resolution and settlement,
///      withdrawals. Reverts are expected along the way (a busy slot, a resolved market,
///      the last share) and are swallowed — the invariants below are about the state that
///      results, not about which calls succeed.
contract Handler is Test {
    LiquidityVault public vault;
    MockUSDC public usdc;
    MockPool public pool;
    MockOutcome6909 public outcome;
    MockMarket public market;

    address public operator;
    address public alice;
    /// Three windows on the same pool, so several slots can be live at once and the
    /// one-market-one-slot rule gets exercised rather than sidestepped.
    bytes32[3] public MARKETS = [bytes32(uint256(0xB7C)), bytes32(uint256(0xB7D)), bytes32(uint256(0xB7E))];

    uint64 public expiry;
    bool public resolved;

    constructor(LiquidityVault v, MockUSDC u, MockPool p, MockOutcome6909 o, MockMarket m, address op, address a, uint64 exp) {
        vault = v; usdc = u; pool = p; outcome = o; market = m; operator = op; alice = a; expiry = exp;
    }

    function deposit(uint256 amount) external {
        amount = bound(amount, 1e6, 500e6);
        usdc.mint(alice, amount);
        vm.startPrank(alice);
        usdc.approve(address(vault), amount);
        try vault.deposit(amount, alice) {} catch {}
        vm.stopPrank();
    }

    function quote(uint256 slot, uint256 which, uint256 mid, uint256 half, uint256 size) external {
        slot = bound(slot, 0, vault.MAX_SLOTS() - 1);
        which = bound(which, 0, 2);
        mid = bound(mid, 100_000, 900_000);
        half = bound(half, vault.minHalfSpread(), 60_000);
        size = bound(size, 1e6, 200e6);
        vm.prank(operator);
        try vault.quote(slot, MARKETS[which], mid, half, size) {} catch {}
    }

    /// One whole leg is taken by the market. The mock pool then treats the id as dead,
    /// exactly as the real one does.
    function fill(uint256 slot, bool yesLeg) external {
        slot = bound(slot, 0, vault.MAX_SLOTS() - 1);
        LiquidityVault.Slot memory s = vault.slots(slot);
        if (!s.active) return;
        uint128 id = yesLeg ? s.yesOrderId : s.noOrderId;
        if (id == 0 || pool.filled(id)) return;
        pool.fill(id);
        uint256 tokenId = yesLeg ? s.yesId : s.noId;
        outcome.setBalance(address(vault), tokenId, outcome.balanceOf(address(vault), tokenId) + s.size);
    }

    function cancel(uint256 slot) external {
        slot = bound(slot, 0, vault.MAX_SLOTS() - 1);
        vm.prank(operator);
        try vault.cancelQuote(slot) {} catch {}
    }

    function flatten(uint256 slot) external {
        slot = bound(slot, 0, vault.MAX_SLOTS() - 1);
        vm.prank(operator);
        try vault.flatten(slot) {} catch {}
    }

    /// The window ends. From here no quote can be placed; every slot must be settled.
    function resolve(bool yesWins) external {
        if (resolved) return;
        vm.warp(expiry + 1);
        if (yesWins) market.resolve(10_000_000, 0);
        else market.resolve(0, 10_000_000);
        resolved = true;
    }

    function settle(uint256 slot) external {
        slot = bound(slot, 0, vault.MAX_SLOTS() - 1);
        try vault.settle(slot) {} catch {}
    }

    function withdraw(uint256 shares) external {
        uint256 have = vault.balanceOf(alice);
        if (have == 0) return;
        shares = bound(shares, 1, have);
        vm.prank(alice);
        try vault.redeem(shares, alice, alice) {} catch {}
    }
}

/// @title What must hold no matter what order things happen in.
/// @notice Every one of these was violated by a build that ran on Shannon. The stored
///         escrow counter drifted the moment a leg filled; NAV carried a naked leg at
///         what it cost; the last share could leave with a slot still open. They are
///         stated here as properties of the state, and fuzzed across thousands of
///         interleavings rather than the handful a human thinks of.
contract LiquidityVaultInvariantTest is StdInvariant, Test {
    LiquidityVault vault;
    MockUSDC usdc;
    MockPool pool;
    MockOutcome6909 outcome;
    MockMarket market;
    MockModule module;
    Handler handler;

    address governor = address(0x9012);
    address operator = address(0x0B07);
    address alice = address(0xA11CE);

    function setUp() public {
        vm.warp(1_800_000_000);
        uint64 tradingStart = uint64(block.timestamp);
        uint64 expiry = tradingStart + 900;

        usdc = new MockUSDC();
        module = new MockModule();
        pool = new MockPool(IERC20(address(usdc)));
        outcome = new MockOutcome6909();
        market = new MockMarket();
        module.set(bytes32(uint256(0xB7C)), address(pool), tradingStart, expiry);
        module.setSettlement(bytes32(uint256(0xB7C)), address(market), 111, 222);
        // Two more windows on the same pool; they stay trading when the first resolves.
        module.set(bytes32(uint256(0xB7D)), address(pool), tradingStart, expiry + 900);
        module.setSettlement(bytes32(uint256(0xB7D)), address(new MockMarket()), 333, 444);
        module.set(bytes32(uint256(0xB7E)), address(pool), tradingStart, expiry + 1800);
        module.setSettlement(bytes32(uint256(0xB7E)), address(new MockMarket()), 555, 666);
        module.wire(outcome, usdc);

        vault = new LiquidityVault(
            IERC20(address(usdc)), IBinaryMarketsModule(address(module)), IOutcomeToken6909(address(outcome)), governor, 1e3, 1e3
        );
        vm.prank(governor);
        vault.setOperator(operator);

        handler = new Handler(vault, usdc, pool, outcome, market, operator, alice, expiry);
        targetContract(address(handler));
    }

    /// NAV is exactly cash, plus what is still resting, plus complete sets at one apiece.
    /// A naked leg contributes nothing. There is no fourth term.
    function invariant_navIsCashPlusRestingPlusCompleteSets() public view {
        uint256 sets;
        for (uint256 i = 0; i < vault.MAX_SLOTS(); i++) {
            LiquidityVault.Slot memory s = vault.slots(i);
            if (!s.active) continue;
            uint256 yes = outcome.balanceOf(address(vault), s.yesId);
            uint256 no = outcome.balanceOf(address(vault), s.noId);
            sets += yes < no ? yes : no;
        }
        assertEq(vault.totalAssets(), usdc.balanceOf(address(vault)) + vault.totalEscrowed() + sets);
    }

    /// The vault's derived escrow must agree with what the pool is actually holding for
    /// its live orders. The pool is the other party; it keeps its own books.
    function invariant_restingEscrowMatchesThePoolsOwnLedger() public view {
        uint256 atPool;
        for (uint256 i = 0; i < vault.MAX_SLOTS(); i++) {
            LiquidityVault.Slot memory s = vault.slots(i);
            if (!s.active) continue;
            if (s.yesOrderId != 0) atPool += pool.escrowOf(s.yesOrderId);
            if (s.noOrderId != 0) atPool += pool.escrowOf(s.noOrderId);
        }
        assertEq(vault.totalEscrowed(), atPool);
    }

    /// Shares can never be worth more than the assets behind them.
    function invariant_sharesNeverOverstateAssets() public view {
        assertLe(vault.convertToAssets(vault.totalSupply()), vault.totalAssets());
    }

    /// Idle is exactly the collateral on hand — no phantom cash, no hidden cash.
    function invariant_idleIsTheBalance() public view {
        assertEq(vault.idleAssets(), usdc.balanceOf(address(vault)));
    }

    /// If any slot is open there is a share left to own it.
    function invariant_noOpenSlotWithoutAShareholder() public view {
        bool open;
        for (uint256 i = 0; i < vault.MAX_SLOTS(); i++) if (vault.slots(i).active) open = true;
        if (open) assertGt(vault.totalSupply(), 0, "an open slot must belong to someone");
    }
}
