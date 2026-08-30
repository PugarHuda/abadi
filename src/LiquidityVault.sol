// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {AbadiReactive} from "./AbadiReactive.sol";
import {MarketEngine} from "./MarketEngine.sol";
import {IBinaryPool, IBinaryMarket, IOutcomeToken6909, ORDER_KIND, ORDER_TYPE} from "./interfaces/IBinaryPool.sol";
import {IBinaryMarketsModule, MarketStatus} from "./interfaces/IBinaryMarketsModule.sol";

/// @title LiquidityVault
/// @notice Zero-inventory two-sided quoting on DreamDEX Event Contracts.
///
/// @dev Why this is the primary product, from measurement rather than opinion:
///      across 2,422 settled markets UP won 49.96% of the time (z = -0.04 against a
///      fair coin), while the venue quotes a flat 2.9% spread on every market and every
///      tier. With outcomes that are a coin flip, crossing the spread is -1.45% per
///      contract and collecting it is +1.45%. Making is the side with the edge here.
///
///      The mechanism, using the venue's mint-a-pair fill path:
///
///        BUY_YES @ p       escrows p         per contract
///        BUY_NO  @ p + s   escrows 1-(p+s)   per contract   (price is always YES-side)
///        -----------------------------------------------
///        pair cost         1 - s
///
///      Two opposite-side buyers cross with no seller — the pool mints a fresh YES/NO
///      pair. A filled pair is worth exactly 1 at settlement whichever way the market
///      resolves, so the spread is captured with no directional exposure and no
///      inventory is ever required up front.
///
///      Custody follows the shape the DreamDEX team confirmed is the only one that works
///      today: BinaryPool has no operator gate, so the CONTRACT owns the orders and the
///      collateral. The operator key can quote and cancel; it can never move a token out.
contract LiquidityVault is ERC4626, AbadiReactive, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using MarketEngine for uint256;

    // -------------------------------------------------------------- constants

    /// @dev Concurrent markets quoted. Bounded so NAV stays a bounded loop.
    uint256 public constant MAX_SLOTS = 8;

    /// @dev Quotes rest but must never take. Crossing is the -1.45% side of this trade.
    uint8 private constant POST_ONLY = ORDER_TYPE.POST_ONLY;

    // ---------------------------------------------------------------- storage

    IBinaryMarketsModule public immutable module;

    /// @notice Shared ERC-6909 singleton. Up and Down are token ids on this one contract.
    IOutcomeToken6909 public immutable outcomeToken;

    /// @notice May quote and cancel. May NOT withdraw, transfer, or reprice shares.
    address public operator;

    /// @notice Governs the operator and the risk parameters. Not the assets.
    address public governor;

    /// @dev Two-step, because a single-step transfer to a mistyped address hands the
    ///      operator seat to nobody, permanently. Slither wanted `governor` immutable —
    ///      which would make losing the key unrecoverable, so the answer is a transfer
    ///      path, not a constant.
    address public pendingGovernor;

    /// @notice 1.0 in price units = 10 ** collateral.decimals(). NOT 1e18.
    /// @dev Read from the token at construction, never hardcoded: tUSDC is 6 decimals on
    ///      testnet and USDso is 18 on mainnet, a factor of 10^12. A literal here
    ///      misprices every order on one network and nothing reverts to say so.
    ///      Confirmed against a working order: 0.727 submits as `727000` on 6 decimals.
    uint256 public immutable priceOne;

    /// @dev Venue tick and lot grids, in the same collateral-scaled units as `priceOne`.
    ///      On Shannon the venue publishes precision.price = 3, so tickSize = 0.001,
    ///      which is 1000 at 6 decimals.
    uint256 public tickSize;
    uint256 public lotSize;

    /// @dev Minimum life a window must have left, in bps of its own interval. A fixed
    ///      seconds threshold is wrong here: the venue runs 60s through 86400s tiers.
    uint16 public headroomBps = 1000; // 10%

    /// @dev Floor on the half-spread we will quote, in 1e18 price units. Quoting inside
    ///      this is how a maker turns an edge into adverse selection for free.
    /// @dev In price units, so it scales with the collateral. Set at construction from
    ///      `priceOne` rather than as a literal.
    uint256 public minHalfSpread;

    struct Slot {
        bytes32 marketId;
        address pool;
        uint128 yesOrderId;
        uint128 noOrderId;
        uint256 basis; // what the two legs cost at quote time; a record, not a balance
        uint256 size; // contracts quoted per side
        uint256 bidPrice; // YES-side price of the BUY_YES leg
        uint256 askPrice; // YES-side price of the BUY_NO leg
        uint256 yesId; // ERC-6909 ids, cached so NAV needs no registry lookup
        uint256 noId;
        bool active;
    }

    Slot[MAX_SLOTS] private _slots;

    /// @notice Collateral still resting behind unfilled quote legs.
    /// @dev Derived on read, never stored. The stored counter drifted the instant one leg
    ///      of a two-sided quote filled: that escrow had been spent, nothing told the
    ///      counter, and NAV went on carrying a directional leg at what it cost instead of
    ///      what it was worth. A number that has to be kept in step with four other
    ///      functions eventually is not.
    function totalEscrowed() public view returns (uint256 resting) {
        for (uint256 i = 0; i < MAX_SLOTS; i++) {
            Slot storage s = _slots[i];
            if (s.active) resting += _restingEscrow(s);
        }
    }

    /// @dev A leg holds escrow only for the part of it that has not filled, and only
    ///      while its order is still live. A cancelled leg has its id zeroed, which is
    ///      what says the collateral came back.
    function _restingEscrow(Slot storage s) internal view returns (uint256 resting) {
        if (s.yesOrderId != 0) {
            uint256 yes = outcomeToken.balanceOf(address(this), s.yesId);
            if (yes < s.size) resting += MarketEngine.costOf(s.size - yes, s.bidPrice, priceOne);
        }
        if (s.noOrderId != 0) {
            uint256 no = outcomeToken.balanceOf(address(this), s.noId);
            if (no < s.size) {
                resting += MarketEngine.costOf(s.size - no, MarketEngine.mirror(s.askPrice, priceOne), priceOne);
            }
        }
    }

    // ----------------------------------------------------------------- events

    event Quoted(uint256 indexed slot, bytes32 indexed marketId, uint256 bid, uint256 ask, uint256 size);
    event Cancelled(uint256 indexed slot, bytes32 indexed marketId);
    event OperatorSet(address indexed operator);
    event RiskParamsSet(uint16 headroomBps, uint256 minHalfSpread);
    event GridSet(uint256 tickSize, uint256 lotSize);
    event NativeSwept(address indexed to, uint256 amount);
    event Settled(uint256 indexed slot, bytes32 indexed marketId, uint256 redeemed, bool voided);
    event Flattened(uint256 indexed slot, bytes32 indexed marketId, uint256 pairs, uint256 returned);
    event Swept(uint256 indexed firesAtMillis, uint256 slotsReleased);
    event GovernanceOffered(address indexed from, address indexed to);
    event GovernanceTransferred(address indexed from, address indexed to);

    // ----------------------------------------------------------------- errors

    error NotOperator(address caller);
    error NotGovernor(address caller);
    error SlotOutOfRange(uint256 slot);
    error SlotBusy(uint256 slot);
    error SlotIdle(uint256 slot);
    error MarketNotTrading(bytes32 marketId, uint8 status);
    error NoHeadroom(bytes32 marketId);
    error SpreadTooTight(uint256 halfSpread);
    error SizeFlooredToZero();
    error InsufficientIdle(uint256 needed, uint256 available);
    error OrderRejected(uint8 kind);
    error MarketNotSettled(bytes32 marketId, uint8 status);
    error OnlyOperatorWhileTrading(bytes32 marketId);
    error NothingToFlatten(bytes32 marketId);
    error OperatorGrantFailed();
    error NotPendingGovernor(address caller);
    error NotSelf(address caller);
    error LastShareWhileOpen(uint256 slot);
    error MarketAlreadyQuoted(bytes32 marketId, uint256 slot);
    error CancelFailed(uint128 orderId, bytes reason);
    /// @dev The pool's own answer for an order id it no longer holds for the caller.
    error IncorrectSender(address caller, address owner);

    // ------------------------------------------------------------ constructor

    constructor(
        IERC20 collateral_,
        IBinaryMarketsModule module_,
        IOutcomeToken6909 outcomeToken_,
        address governor_,
        uint256 tickSize_,
        uint256 lotSize_
    ) ERC4626(collateral_) ERC20("Abadi Liquidity", "abLIQ") {
        module = module_;
        outcomeToken = outcomeToken_;
        // The module PULLS winning outcome tokens on redemption. One grant covers every
        // id and every market, so redemption never needs a second approval later.
        // A token that answers false instead of reverting would leave the vault able to
        // buy positions and unable to redeem them, discovered only at settlement.
        if (!outcomeToken_.setOperator(address(module_), true)) revert OperatorGrantFailed();
        governor = governor_;
        tickSize = tickSize_;
        lotSize = lotSize_;
        priceOne = 10 ** IERC20Metadata(address(collateral_)).decimals();
        minHalfSpread = priceOne / 400; // 0.0025 -> a 0.5% round trip floor
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator(msg.sender);
        _;
    }

    modifier onlyGovernor() {
        if (msg.sender != governor) revert NotGovernor(msg.sender);
        _;
    }

    // ------------------------------------------------------------ NAV / 4626

    /// @notice Idle collateral, plus resting escrow, plus complete sets at their true worth.
    /// @dev Share price is a transfer of value between users, so this cannot be lazy.
    ///      Carrying a filled position at cost under-reports NAV by exactly the spread
    ///      just captured, and a depositor arriving in that window buys in cheap and
    ///      dilutes everyone already there.
    ///
    ///      A complete set is worth exactly 1 collateral per pair at any moment, whichever
    ///      way the market later resolves, so it is marked at 1 — not estimated.
    ///
    ///      A leg WITHOUT a partner stays at cost. It is directional and only settlement
    ///      resolves it; marking it to the book would import the book's noise into the
    ///      share price, and a thin book moves for reasons that have nothing to do with
    ///      the position's worth.
    function totalAssets() public view override returns (uint256) {
        uint256 total = IERC20(asset()).balanceOf(address(this));
        for (uint256 i = 0; i < MAX_SLOTS; i++) {
            Slot storage s = _slots[i];
            if (!s.active) continue;
            total += _restingEscrow(s);
            uint256 yes = outcomeToken.balanceOf(address(this), s.yesId);
            uint256 no = outcomeToken.balanceOf(address(this), s.noId);
            // A complete set redeems for exactly 1 per pair whichever side wins, so it is
            // worth its own size. A leg without a partner is a directional bet, and
            // marking it at what it cost is how the next depositor buys into a loss that
            // has already happened. It is worth nothing here until settlement says
            // otherwise: NAV may understate, never overstate.
            total += yes < no ? yes : no;
        }
        return total;
    }

    /// @dev A withdrawal that takes the share supply to zero while a slot is still open
    ///      orphans that slot's proceeds: ERC-4626 assigns them to the virtual share and
    ///      no later deposit can recover them. That happened on Shannon — 102.13 tUSDC
    ///      settled into a vault whose last share had already been redeemed, and the
    ///      re-seed to get it out lost more to rounding than it retrieved. The last
    ///      holder waits for the slots to close; everyone before them is unaffected.
    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
    {
        if (shares == totalSupply()) {
            for (uint256 i = 0; i < MAX_SLOTS; i++) {
                if (_slots[i].active) revert LastShareWhileOpen(i);
            }
        }
        super._withdraw(caller, receiver, owner, assets, shares);
    }

    /// @notice Collateral not currently committed to a quote.
    function idleAssets() public view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    function slots(uint256 i) external view returns (Slot memory) {
        if (i >= MAX_SLOTS) revert SlotOutOfRange(i);
        return _slots[i];
    }

    // ------------------------------------------------------------- operations

    /// @notice Rest a two-sided, zero-inventory quote around `mid` on `marketId`.
    /// @param mid        YES-side mid price, 1e18-scaled.
    /// @param halfSpread Half the quoted spread, 1e18-scaled.
    /// @param size       Contracts per side, before lot quantization.
    /// @dev The operator chooses the market and the price; it can never choose where the
    ///      money goes. Every leg is POST_ONLY: if a leg would cross it is rejected by
    ///      the pool rather than paying the spread we exist to collect.
    function quote(uint256 slot, bytes32 marketId, uint256 mid, uint256 halfSpread, uint256 size)
        external
        onlyOperator
        nonReentrant
    {
        if (slot >= MAX_SLOTS) revert SlotOutOfRange(slot);
        if (_slots[slot].active) revert SlotBusy(slot);
        if (halfSpread < minHalfSpread) revert SpreadTooTight(halfSpread);
        // One market, one slot. Outcome balances live on the ERC-6909 per market, not
        // per slot, so two slots on the same window would read each other's fills:
        // resting escrow undercounted, complete sets counted twice. The invariant
        // fuzzer found it in its first minute; the bot had been avoiding it by luck.
        for (uint256 i = 0; i < MAX_SLOTS; i++) {
            if (_slots[i].active && _slots[i].marketId == marketId) revert MarketAlreadyQuoted(marketId, i);
        }

        (address pool, uint64 expiry, uint64 intervalSec) = _requireTradable(marketId);
        (,,,,,,,,,, uint256 yesId_, uint256 noId_,,) = module.markets(marketId);

        uint256 bid = MarketEngine.floorToTick(mid - halfSpread, tickSize);
        uint256 ask = MarketEngine.ceilToTick(mid + halfSpread, tickSize);
        MarketEngine.requireProbability(bid, priceOne);
        MarketEngine.requireProbability(ask, priceOne);

        uint256 qty = MarketEngine.quantize(size, lotSize);
        if (qty == 0) revert SizeFlooredToZero();

        // BUY_YES pays `bid`; BUY_NO is quoted YES-side at `ask` and pays (1 - ask).
        uint256 escrow = MarketEngine.costOf(qty, bid, priceOne)
            + MarketEngine.costOf(qty, MarketEngine.mirror(ask, priceOne), priceOne);
        uint256 idle = idleAssets();
        if (escrow > idle) revert InsufficientIdle(escrow, idle);

        uint64 deadlineNs = MarketEngine.expiryNs(expiry, expiry);
        IERC20(asset()).forceApprove(pool, escrow);

        uint64 tag = uint64(uint256(marketId) ^ slot);
        _place(pool, ORDER_KIND.BUY_YES, bid, qty, deadlineNs, tag, slot, true);
        _place(pool, ORDER_KIND.BUY_NO, ask, qty, deadlineNs, tag, slot, false);

        _slots[slot] = Slot({
            marketId: marketId,
            pool: pool,
            yesOrderId: _slots[slot].yesOrderId,
            noOrderId: _slots[slot].noOrderId,
            basis: escrow,
            size: qty,
            bidPrice: bid,
            askPrice: ask,
            yesId: yesId_,
            noId: noId_,
            active: true
        });

        // Silence the unused-variable warning without weakening the read: intervalSec is
        // consumed inside _requireTradable's headroom check.
        intervalSec;

        emit Quoted(slot, marketId, bid, ask, qty);
    }

    /// @notice Pull both legs of a slot and return its escrow to idle.
    function cancelQuote(uint256 slot) external onlyOperator nonReentrant {
        if (slot >= MAX_SLOTS) revert SlotOutOfRange(slot);
        Slot storage s = _slots[slot];
        if (!s.active) revert SlotIdle(slot);

        IBinaryPool pool = IBinaryPool(s.pool);
        // Past the window nothing can fill, so a cancel the pool refuses is survivable --
        // but only by leaving the id in place. Inside the window a refusal is a real
        // failure and must revert.
        bool mayFail = _statusOf(s.marketId) != MarketStatus.TRADING;
        if (_cancelIfLive(pool, s.yesOrderId, mayFail)) s.yesOrderId = 0;
        if (_cancelIfLive(pool, s.noOrderId, mayFail)) s.noOrderId = 0;

        bytes32 id = s.marketId;
        // Pulling the orders does not pull what they already bought. A slot still holding
        // outcome tokens has to stay open for `settle` to find: deleting it orphans them
        // on the ERC-6909 with no function left that can redeem them, and a losing side
        // today is a winning side on the market that goes the other way.
        // The same is true of a leg the pool would not let go of.
        if (s.yesOrderId == 0 && s.noOrderId == 0
            && outcomeToken.balanceOf(address(this), s.yesId) == 0
            && outcomeToken.balanceOf(address(this), s.noId) == 0) {
            delete _slots[slot];
        }

        emit Cancelled(slot, id);
    }

    /// @notice Merge held complete sets back to collateral without waiting for settlement.
    /// @dev A complete set is worth exactly 1 collateral at any time, so there is no
    ///      reason to leave it idle until the window resolves. `mergeCompleteSet` returns
    ///      it immediately and the capital can quote again.
    ///
    ///      Access is deliberately split rather than fully open. `settle` can be
    ///      permissionless because a settled market cannot trade — there is nothing to
    ///      destroy. `flatten` is different: cancelling a live quote throws away the
    ///      spread the vault exists to earn, so an open version would let anyone grief
    ///      the vault by repeatedly closing good quotes.
    ///
    ///      So: the operator may flatten whenever it judges a quote dead, and ANYONE may
    ///      flatten once the market can no longer trade. Past that point no fill is
    ///      possible, so there is no value left to destroy and no reason to let capital
    ///      sit behind a key that may have gone quiet.
    function flatten(uint256 slot) external nonReentrant returns (uint256 returned) {
        if (slot >= MAX_SLOTS) revert SlotOutOfRange(slot);
        Slot storage s = _slots[slot];
        if (!s.active) revert SlotIdle(slot);

        uint8 status = _statusOf(s.marketId);
        if (msg.sender != operator && status == MarketStatus.TRADING) {
            revert OnlyOperatorWhileTrading(s.marketId);
        }

        uint256 yes = outcomeToken.balanceOf(address(this), s.yesId);
        uint256 no = outcomeToken.balanceOf(address(this), s.noId);
        uint256 pairs = yes < no ? yes : no;
        if (pairs == 0) revert NothingToFlatten(s.marketId);

        // Pull whatever is still resting first: its escrow is released by the pool, and
        // leaving it live after flattening would re-open exposure this call just closed.
        IBinaryPool pool = IBinaryPool(s.pool);
        bool mayFail = status != MarketStatus.TRADING;
        if (_cancelIfLive(pool, s.yesOrderId, mayFail)) s.yesOrderId = 0;
        if (_cancelIfLive(pool, s.noOrderId, mayFail)) s.noOrderId = 0;

        uint256 before = IERC20(asset()).balanceOf(address(this));
        module.mergeCompleteSet(0, bytes32(0), s.marketId, pairs);
        returned = IERC20(asset()).balanceOf(address(this)) - before;

        bytes32 id = s.marketId;
        // An uneven fill leaves a single-side leg that cannot be merged and still carries
        // direction. That one has to wait for settlement, so the slot stays open for it --
        // as does a leg the frozen book would not give back.
        if (yes == no && s.yesOrderId == 0 && s.noOrderId == 0) delete _slots[slot];

        emit Flattened(slot, id, pairs, returned);
    }

    /// @notice Redeem a settled slot and free it. Permissionless by design.
    /// @dev Anyone may call this, and there is nothing to steal: proceeds go to the
    ///      vault, never to the caller. Leaving redemption to a privileged key is how
    ///      capital gets stranded in resolved markets when that key goes quiet — the
    ///      same failure mode as a contract that can receive funds but not release them.
    ///
    ///      A settled market leaves the live list entirely, so nothing upstream will
    ///      remind the vault this position exists. Redemption has to be pulled.
    function settle(uint256 slot) external nonReentrant returns (uint256 redeemed) {
        return _settle(slot);
    }

    function _settle(uint256 slot) internal returns (uint256 redeemed) {
        if (slot >= MAX_SLOTS) revert SlotOutOfRange(slot);
        Slot storage s = _slots[slot];
        if (!s.active) revert SlotIdle(slot);

        (,,,,,,,, address market,,,,,) = module.markets(s.marketId);
        bool resolved = IBinaryMarket(market).isResolved();
        bool voided = IBinaryMarket(market).isVoided();
        if (!resolved && !voided) revert MarketNotSettled(s.marketId, _statusOf(s.marketId));

        // Effects before interactions. The slot is cleared up front so a reentrant call
        // finds nothing to redeem twice; the values it needs are copied to memory first.
        bytes32 id = s.marketId;
        uint256 yesId = s.yesId;
        uint256 noId = s.noId;
        IBinaryPool pool = IBinaryPool(s.pool);
        uint128 yesOrderId = s.yesOrderId;
        uint128 noOrderId = s.noOrderId;
        delete _slots[slot];

        // A leg that never filled is still resting, and a resolved market will never fill
        // it. Leaving it there strands its escrow at the pool for as long as the pool
        // lives, which is the whole point of settling. A refusal cannot brick settlement:
        // the market is terminal, so the pool releases what it holds to the owner on
        // finalization regardless -- measured at 98.40 of 98.40 on a window that came back
        // this way -- and settlement is the last event, so there is no slot left to keep.
        _cancelIfLive(pool, yesOrderId, true);
        _cancelIfLive(pool, noOrderId, true);

        uint256 before = IERC20(asset()).balanceOf(address(this));

        if (voided) {
            // A voided market pays 0.5 on BOTH sides, so both must be redeemed. Redeeming
            // only the "winner" here would silently abandon half the position.
            _redeemOutcome(id, 0, yesId);
            _redeemOutcome(id, 1, noId);
        } else {
            // `winningOutcome()` was removed in settlement v3 and now reverts. The winner
            // is the argmax of the payout vector.
            uint256[] memory payouts = IBinaryMarket(market).payoutNumerators();
            uint8 winner = 0;
            for (uint256 i = 1; i < payouts.length; i++) {
                if (payouts[i] > payouts[winner]) winner = uint8(i);
            }
            _redeemOutcome(id, winner, winner == 0 ? yesId : noId);
        }

        // A slot that holds only the losing side redeems nothing, and that is a result,
        // not a failure. Reverting here left such a slot active forever: `flatten` refuses
        // it for want of a pair, `cancelQuote` cannot cancel a filled leg, and the escrow
        // counter went on quoting a number for capital that was already gone.
        redeemed = IERC20(asset()).balanceOf(address(this)) - before;

        emit Settled(slot, id, redeemed, voided);
    }

    /// @dev The pool reverts `IncorrectSender` on an order id it no longer owns, which is
    ///      what a filled leg looks like from here. That revert must never brick the exit:
    ///      a one-sided fill is precisely the slot with something to get out of, and it is
    ///      also precisely the slot with one dead id. The sweep already knew this; the
    ///      three paths a human calls did not.
    ///
    ///      The second answer that must not brick anything is the frozen book. From the
    ///      instant a window expires until its market goes terminal, the pool refuses
    ///      every write to its book -- cancelOrder, cancelOrders, cancelExpiredOrders and
    ///      sweepExpiredAtLevel all return the same undecodable error -- and accepts them
    ///      again once the market is resolved or voided. Reverting on that bricked all
    ///      three exits in the gap: the sweep did nothing on the one shape it exists for,
    ///      and `flatten`, whose whole point is that ANYONE may call it once the market
    ///      can no longer trade, could not be called by anyone at all.
    ///
    ///      So the caller says whether a failure is survivable, and it is survivable
    ///      exactly when no fill is possible -- when the market can no longer trade. What
    ///      is NOT survivable is forgetting the order: a vault that shrugged and cleared
    ///      the id anyway would be carrying escrow it no longer knows about. That happened
    ///      on Shannon: a slot was freed, its two legs stayed live, both filled later, and
    ///      200 outcome tokens turned up under a slot that had quoted 100. Hence the
    ///      return value -- the caller clears an id only when this says the pool is done
    ///      with it, and keeps the slot open for whatever is left.
    /// @return cleared true when the pool holds nothing further under this order id.
    function _cancelIfLive(IBinaryPool pool, uint128 orderId, bool mayFail) internal returns (bool cleared) {
        if (orderId == 0) return true;
        try pool.cancelOrder(orderId) {
            return true;
        } catch (bytes memory reason) {
            if (reason.length >= 4 && bytes4(reason) == IncorrectSender.selector) return true; // already gone
            if (mayFail) return false; // frozen book: cannot fill, cannot cancel, still owed
            revert CancelFailed(orderId, reason);
        }
    }

    function _redeemOutcome(bytes32 marketId, uint8 outcomeIdx, uint256 tokenId) internal {
        uint256 held = outcomeToken.balanceOf(address(this), tokenId);
        if (held == 0) return;
        // `(operatorId, venueId)` are attribution-only and may be zero.
        module.redeem(0, bytes32(0), marketId, outcomeIdx, held);
    }

    // -------------------------------------------------------- keeper-free sweep

    /// @notice Wake the vault at `firesAtSec` to release whatever the window left behind.
    /// @dev This is what makes the name literal: a window expires, and the vault frees its
    ///      own capital without anyone calling it. Quotes on a dead window earn nothing and
    ///      their escrow is stuck until something cancels them, so the something is the
    ///      chain itself.
    ///
    ///      Arming costs native currency for the callback, and the precompile requires the
    ///      handler to hold at least 32 STT on testnet — `_arm` reverts with `Underfunded`
    ///      rather than letting the precompile fail with empty data.
    /// @dev Gas for the callback. The first live wake-up on Shannon was armed at 500,000
    ///      and ran OUT_OF_GAS with one idle slot to look at — `eth_estimateGas` from the
    ///      precompile's address put that no-op sweep at 1,151,045. The limit is sized for
    ///      the worst case: MAX_SLOTS slots all needing the dead-oracle path, measured on
    ///      Shannon at voidExpired 694,993 + syncSettlement 2,322,671 + finalizeMarket
    ///      1,617,295 + settle 679,349 = 5,314,308 for one slot. 8,000,000 covered barely
    ///      one and a half of those. The precompile accepts up to 200,000,000; only gas
    ///      actually used is paid for, and it is paid out of the handler's own balance —
    ///      so the ceiling that matters is not this number but MIN_HANDLER_BALANCE, which
    ///      a full 40M sweep at the 50 gwei cap would cost 2 STT of.
    uint64 public constant SWEEP_GAS = 40_000_000;

    function armSweep(uint64 firesAtSec) external onlyOperator returns (uint256 subscriptionId) {
        return _arm(uint256(firesAtSec) * 1000, 10 gwei, 50 gwei, SWEEP_GAS);
    }

    function disarmSweep(uint64 firesAtSec) external onlyOperator {
        _disarm(uint256(firesAtSec) * 1000);
    }

    /// @dev Runs inside the reactivity callback. A callback that reverts is LOST — there
    ///      is no retry and no error surface — so every slot is handled independently and
    ///      a failure on one must not take down the rest. Each slot goes through its own
    ///      guarded external self-call: a revert in one is caught here, and the guard is
    ///      held per slot rather than across the whole sweep so a slot is never half done
    ///      when something else touches it.
    function _onScheduled(uint256 firesAtMillis) internal override {
        uint256 released = 0;
        for (uint256 i = 0; i < MAX_SLOTS; i++) {
            if (!_slots[i].active) continue;
            if (_statusOf(_slots[i].marketId) == MarketStatus.TRADING) continue; // still earning
            try this.releaseSlot(i) returns (bool closed) {
                if (closed) released++;
            } catch {}
        }
        emit Swept(firesAtMillis, released);
    }

    /// @notice One slot's share of a sweep. Callable only by the vault itself.
    /// @dev Settles if the market went terminal — that is the whole lifecycle closing with
    ///      no one calling it. If it did not, the oracle is the reason, and this takes the
    ///      market's own escape hatch rather than waiting for one: `voidExpired` opens at
    ///      `expiry + settlementWindow` and pays both sides 0.5, which is exactly what a
    ///      window nobody can price is worth. Two Shannon windows sat unresolved for two
    ///      days with 196 of this vault's escrow frozen behind them while `pokeOracle`
    ///      answered every fifteen minutes and resolved nothing; the hatch had been open
    ///      the whole time.
    ///
    ///      The hatch writes the market directly, so the module never learns of it. The
    ///      two permissionless nudges that follow are not optional: `syncSettlement`
    ///      releases the hub earmark the adapter never released, `finalizeMarket` moves
    ///      the pool's backing into settlement, and without them `_settle` redeems into
    ///      an empty settlement and returns nothing. Each is wrapped: a market that is
    ///      already terminal reaches here through the same path, and their no-op guards
    ///      are the venue's business, not a reason to lose the sweep.
    function releaseSlot(uint256 slot) external nonReentrant returns (bool closed) {
        if (msg.sender != address(this)) revert NotSelf(msg.sender);
        Slot storage s = _slots[slot];
        if (!s.active) return true;

        bytes32 id = s.marketId;
        (,,,,,,,, address market,,,,,) = module.markets(id);
        IBinaryMarket mkt = IBinaryMarket(market);

        if (!mkt.isResolved() && !mkt.isVoided()) {
            try mkt.voidExpired() {} catch {}
        }
        if (mkt.isResolved() || mkt.isVoided()) {
            try module.syncSettlement(id) {} catch {}
            try module.finalizeMarket(id) {} catch {}
            _settle(slot);
            return true;
        }
        return _release(slot);
    }

    /// @dev Merge any complete set back to collateral. Reached only from the sweep, and
    ///      only for a market that is neither trading nor terminal — the gap between a
    ///      window's expiry and its settlement.
    ///
    ///      It does NOT cancel. Once a window expires the pool freezes its whole book:
    ///      `cancelOrder`, `cancelOrders`, `cancelExpiredOrders` and `sweepExpiredAtLevel`
    ///      all revert with the same error, one the SDK's generated table cannot even
    ///      name. The cancels this used to open with therefore reverted every time, took
    ///      `releaseSlot` down with them, and left the sweep a no-op on the one shape it
    ///      exists for. Nothing was lost by them failing: a frozen order cannot fill, and
    ///      the pool returns its escrow when the market settles — measured at 98.40 of
    ///      98.40 on a window that closed this way.
    /// @return true when the slot was fully closed.
    function _release(uint256 slot) internal returns (bool) {
        Slot storage s = _slots[slot];

        uint256 yes = outcomeToken.balanceOf(address(this), s.yesId);
        uint256 no = outcomeToken.balanceOf(address(this), s.noId);
        uint256 pairs = yes < no ? yes : no;

        if (pairs > 0) {
            try module.mergeCompleteSet(0, bytes32(0), s.marketId, pairs) {} catch {
                return false; // leave it for settle(); do not strand the other slots
            }
        }

        // An uneven fill leaves a naked leg that only settlement can redeem. Keep the
        // slot so `settle` can find it — a settled market vanishes from the live list.
        // The slot is kept whenever anything is still resting, too: the order ids are the
        // only record of what the pool owes this vault when the window finally settles.
        if (yes != no || s.yesOrderId != 0 || s.noOrderId != 0) return false;

        delete _slots[slot];
        return true;
    }

    // ------------------------------------------------------------- governance

    function setOperator(address operator_) external onlyGovernor {
        operator = operator_;
        emit OperatorSet(operator_);
    }

    function setRiskParams(uint16 headroomBps_, uint256 minHalfSpread_) external onlyGovernor {
        headroomBps = headroomBps_;
        minHalfSpread = minHalfSpread_;
        emit RiskParamsSet(headroomBps_, minHalfSpread_);
    }

    /// @notice Nominate the next governor. Takes effect only when they accept.
    function transferGovernance(address to) external onlyGovernor {
        pendingGovernor = to;
        emit GovernanceOffered(governor, to);
    }

    function acceptGovernance() external {
        if (msg.sender != pendingGovernor) revert NotPendingGovernor(msg.sender);
        emit GovernanceTransferred(governor, msg.sender);
        governor = msg.sender;
        pendingGovernor = address(0);
    }

    /// @notice Recover the native gas reserve that funds reactivity callbacks.
    /// @dev The reactivity precompile requires this contract to hold 32 STT before it will
    ///      accept a subscription. `receive()` lets that in; without this, nothing lets it
    ///      out, and 20 STT is already stranded on Shannon in probes that lacked it. Only
    ///      native currency moves here — the collateral is untouched and stays behind
    ///      ERC-4626.
    function sweepNative(address payable to, uint256 amount) external onlyGovernor {
        _sweepNative(to, amount);
        emit NativeSwept(to, amount);
    }

    function setGrid(uint256 tickSize_, uint256 lotSize_) external onlyGovernor {
        tickSize = tickSize_;
        lotSize = lotSize_;
        emit GridSet(tickSize_, lotSize_);
    }

    // ---------------------------------------------------------------- internal

    /// @dev Gates on the LIVE on-chain status, never the indexer: the indexer lags by
    ///      seconds and an order into a locked market reverts.
    function _requireTradable(bytes32 marketId)
        internal
        view
        returns (address pool, uint64 expiry, uint64 intervalSec)
    {
        (,,,,,,,, address market, address pool_,,, uint64 tradingStart, uint64 expiry_) = module.markets(marketId);
        market;
        pool = pool_;
        expiry = expiry_;
        intervalSec = expiry_ > tradingStart ? expiry_ - tradingStart : 0;

        uint8 status = _statusOf(marketId);
        if (status != MarketStatus.TRADING) revert MarketNotTrading(marketId, status);
        if (!MarketEngine.hasHeadroom(uint64(block.timestamp), expiry, intervalSec, headroomBps)) {
            revert NoHeadroom(marketId);
        }
    }

    /// @dev Status is derived from the module's own record. Overridable so tests can
    ///      drive lifecycle transitions without a fork.
    function _statusOf(bytes32 marketId) internal view virtual returns (uint8) {
        (,,,,,,,,,,,, uint64 tradingStart, uint64 expiry) = module.markets(marketId);
        if (block.timestamp < tradingStart) return MarketStatus.LISTED;
        if (block.timestamp >= expiry) return MarketStatus.LOCKED;
        return MarketStatus.TRADING;
    }

    function _place(
        address pool,
        uint8 kind,
        uint256 price,
        uint256 qty,
        uint64 deadlineNs,
        uint64 tag,
        uint256 slot,
        bool isYesLeg
    ) internal {
        (bool ok, uint128 id) = IBinaryPool(pool).placeBinaryOrder(
            kind, price, qty, deadlineNs, POST_ONLY, 0, address(0), 0, tag
        );
        if (!ok) revert OrderRejected(kind);
        if (isYesLeg) _slots[slot].yesOrderId = id;
        else _slots[slot].noOrderId = id;
    }
}
