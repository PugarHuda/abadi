// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/**
 * ERC-4626 conformance, checked by somebody else's rules.
 *
 * Every other test in this repo was written here, which means every one of them encodes
 * this project's own idea of what the vault should do. a16z's `ERC4626Test` does not: it is
 * the standard's requirements as property tests, applied to any vault, and it fuzzes them.
 *
 *   - round-trip — nobody makes a free profit depositing and immediately withdrawing back
 *   - `preview{Deposit,Redeem}` must not over-estimate, `preview{Mint,Withdraw}` must not
 *     under-estimate
 *   - `convertTo{Shares,Assets}` must not vary by caller
 *   - `asset()`, `totalAssets()` and every `max*` MUST NOT revert
 *
 * That last line is why this is worth having rather than a badge. This vault overrides
 * `maxWithdraw` and `maxRedeem` to cap by idle collateral and by the open-slot floor, and it
 * has a redeem delay. Those are exactly the restrictions the standard says `max*` must
 * reflect, and getting them wrong would silently break every integrator's preflight check.
 *
 * The vault is set up here with NO open slot. That is deliberate and it is a limitation
 * worth stating plainly: the a16z properties describe a plain 4626, and a slot holding a
 * one-sided fill makes `totalAssets` move for reasons no generic property can model. What
 * this run proves is that the ERC-4626 surface is conformant while the vault is idle, which
 * is the state every deposit and every withdrawal actually happens in — the vault only
 * quotes what is idle. The open-slot behaviour is covered by the suite next door, which
 * knows what a slot is.
 */
import "erc4626-tests/ERC4626.test.sol";

// a16z's prop file declares its own minimal `IERC20`, so importing OpenZeppelin's by
// that name collides. The vault's constructor takes OZ's, aliased here.
import {IERC20 as IERC20OZ} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LiquidityVault} from "../src/LiquidityVault.sol";
import {IBinaryMarketsModule} from "../src/interfaces/IBinaryMarketsModule.sol";
import {IOutcomeToken6909} from "../src/interfaces/IBinaryPool.sol";
import {MockUSDC, MockModule, MockOutcome6909} from "./LiquidityVault.t.sol";

contract LiquidityVaultConformanceTest is ERC4626Test {
    MockUSDC private usdc;
    MockModule private module;
    MockOutcome6909 private outcome;
    uint64 private _redeemDelay;

    /* The suite deposits for four users and then immediately withdraws, in the same block.
     *
     * This vault refuses that: a deposit cannot be taken back out for `redeemDelay` seconds,
     * which exists so that settling a slot cannot be sandwiched. `maxWithdraw` and
     * `maxRedeem` both return 0 during the window — correctly, and that IS the standard's
     * requirement, that `max*` reflect every restriction — so the fuzzer's assumption of a
     * non-zero withdrawable amount was rejected on every single input and twelve properties
     * reported `vm.assume rejected too many inputs` without ever running.
     *
     * That is a fixture limitation, not a finding: a16z's suite models a vault with no
     * time-based restrictions and never warps. Warping past the delay here puts the vault in
     * the state a withdrawal is legal in, which is the state the properties are about. The
     * delay's own behaviour is asserted next door, by tests that know it exists.
     */
    function setUpVault(Init memory init) public override {
        super.setUpVault(init);
        vm.warp(block.timestamp + _redeemDelay + 1);
    }

    function setUp() public override {
        usdc = new MockUSDC();
        outcome = new MockOutcome6909();
        module = new MockModule();

        LiquidityVault vault = new LiquidityVault(
            IERC20OZ(address(usdc)),
            IBinaryMarketsModule(address(module)),
            IOutcomeToken6909(address(outcome)),
            address(this), // governor
            1000, // tickSize, the venue's 0.001 grid at 6 decimals
            1000 // lotSize
        );

        _underlying_ = address(usdc);
        _vault_ = address(vault);
        _redeemDelay = vault.redeemDelay();
        // Shares carry the asset's decimals here (no offset), so conversions are exact and
        // there is no rounding slack to allow for. If this ever needs a non-zero delta,
        // something about the share scale has changed and the reason belongs in a comment.
        _delta_ = 0;
        _vaultMayBeEmpty = true;
        _unlimitedAmount = false;
    }

    /* The four round-trip properties, with the clock moved between the two halves.
     *
     * a16z's versions deposit and withdraw in one block, which this vault forbids outright:
     * `redeemDelay` exists so that settling a slot cannot be sandwiched, and `maxWithdraw`
     * returns 0 for the whole window. Left alone all four reported `vm.assume rejected too
     * many inputs` and never executed a single case — a green suite that had tested nothing,
     * which is worse than a red one.
     *
     * They are rebuilt here rather than skipped. The property being asserted is unchanged
     * and is the one that matters — a round trip returns no more than it took, so nobody can
     * mint free value by cycling through the vault — and the vault satisfies something
     * stronger besides, since the immediate version of the round trip cannot be performed at
     * all. `checkNoFreeProfit` is reapplied by hand, because the modifier lives on the prop
     * these replace.
     */
    function _noFreeProfit(address caller, uint256 before) private {
        assertApproxLeAbs(_getTotalAssets(caller), before, _delta_);
    }

    function test_RT_deposit_withdraw(Init memory init, uint256 assets) public override {
        setUpVault(init);
        address caller = init.user[0];
        assets = bound(assets, 0, _max_deposit(caller));
        _approve(_underlying_, caller, _vault_, type(uint256).max);
        uint256 before = _getTotalAssets(caller);
        vm.prank(caller);
        uint256 shares1 = vault_deposit(assets, caller);
        vm.warp(block.timestamp + _redeemDelay + 1);
        vm.prank(caller);
        uint256 shares2 = vault_withdraw(assets, caller, caller);
        assertApproxGeAbs(shares2, shares1, _delta_);
        _noFreeProfit(caller, before);
    }

    function test_RT_deposit_redeem(Init memory init, uint256 assets) public override {
        setUpVault(init);
        address caller = init.user[0];
        assets = bound(assets, 0, _max_deposit(caller));
        _approve(_underlying_, caller, _vault_, type(uint256).max);
        uint256 before = _getTotalAssets(caller);
        vm.prank(caller);
        uint256 shares = vault_deposit(assets, caller);
        vm.warp(block.timestamp + _redeemDelay + 1);
        vm.prank(caller);
        uint256 assets2 = vault_redeem(shares, caller, caller);
        assertApproxLeAbs(assets2, assets, _delta_);
        _noFreeProfit(caller, before);
    }

    function test_RT_mint_withdraw(Init memory init, uint256 shares) public override {
        setUpVault(init);
        address caller = init.user[0];
        shares = bound(shares, 0, _max_mint(caller));
        _approve(_underlying_, caller, _vault_, type(uint256).max);
        uint256 before = _getTotalAssets(caller);
        vm.prank(caller);
        uint256 assets = vault_mint(shares, caller);
        vm.warp(block.timestamp + _redeemDelay + 1);
        vm.prank(caller);
        uint256 shares2 = vault_withdraw(assets, caller, caller);
        // Ge, not Le: a round trip must burn at least as many shares as it minted.
        assertApproxGeAbs(shares2, shares, _delta_);
        _noFreeProfit(caller, before);
    }

    function test_RT_mint_redeem(Init memory init, uint256 shares) public override {
        setUpVault(init);
        address caller = init.user[0];
        shares = bound(shares, 0, _max_mint(caller));
        _approve(_underlying_, caller, _vault_, type(uint256).max);
        uint256 before = _getTotalAssets(caller);
        vm.prank(caller);
        uint256 assets1 = vault_mint(shares, caller);
        vm.warp(block.timestamp + _redeemDelay + 1);
        vm.prank(caller);
        uint256 assets2 = vault_redeem(shares, caller, caller);
        assertApproxLeAbs(assets2, assets1, _delta_);
        _noFreeProfit(caller, before);
    }
}
