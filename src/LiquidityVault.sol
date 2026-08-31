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
import {IBinaryPool, PoolOrder, IBinaryMarket, IOutcomeToken6909, ORDER_KIND, ORDER_TYPE} from "./interfaces/IBinaryPool.sol";
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

    /// @notice Most collateral one quote may commit, in asset units. 0 disables the cap.
    /// @dev The custody claim — "the operator key can steer quotes and cannot move a
    ///      token" — is true and was the wrong thing to be reassured by. The operator
    ///      cannot TRANSFER the money; it could trade it away. It picks the market, the
    ///      mid, the half-spread and the size, and before these two limits the only bound
    ///      was `escrow <= idle`: one quote could commit the entire vault. A mispriced
    ///      quote on a near-certain market gets one leg hit and buys something worth
    ///      nothing, and the proceeds land with whoever took the other side.
    ///
    ///      So the bound is on chain now, where the operator cannot reach it, rather than
    ///      in an environment variable on the machine that runs the bot. Governor-set,
    ///      because it is a risk decision and not a trading one.
    uint256 public maxQuoteNotional;

    /// @notice Most of NAV that may be committed to open quotes at once, in bps.
    /// @dev Bounds the whole book rather than one quote: eight slots each inside
    ///      `maxQuoteNotional` can still be the whole vault. Measured utilisation has run
    ///      0-6% of NAV, so this is not a constraint on how the vault actually trades — it
    ///      is a constraint on how far it could be pushed in one direction.
    uint16 public maxDeployedBps;

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

    /// @dev Ask the pool. It is the other party to the order and it keeps the only
    ///      authoritative record of what is still resting under an id.
    ///
    ///      This used to infer the unfilled quantity as `size - balanceOf(outcomeId)`,
    ///      which is only valid while fills are the ONLY thing that moves that balance.
    ///      Two things also move it. `mergeCompleteSet` burns the tokens, so a leg that
    ///      had filled in full read back as never filled and its escrow was counted a
    ///      second time on top of the cash the merge had just delivered — 600.00 of
    ///      reported assets against 503.00 of real cash, and a holder able to redeem the
    ///      difference. And ERC-6909 transfers are permissionless, so a stranger could
    ///      donate outcome tokens and move this vault's share price without touching it.
    ///
    ///      `getOrder` reverts for an id the pool has no active order under, which is
    ///      precisely the answer "nothing is resting here", so the catch returns zero
    ///      rather than propagating. Nothing else in this function can revert, and it is
    ///      on the path of every deposit and every withdrawal.
    function _restingEscrow(Slot storage s) internal view returns (uint256 resting) {
        resting = _legEscrow(s.pool, s.yesOrderId, s.size, s.bidPrice)
            + _legEscrow(s.pool, s.noOrderId, s.size, MarketEngine.mirror(s.askPrice, priceOne));
    }

    /// @dev Capped at the quoted size: what this vault escrowed is all it can be owed.
    ///
    ///      Deliberately a low-level staticcall rather than a typed `try/catch`. A typed
    ///      call does NOT catch two of the failures that matter, because both revert in
    ///      this frame rather than the callee's: a `pool` with no code at all (solc's
    ///      extcodesize check) and a return buffer that does not decode (a shorter or
    ///      differently-shaped `getOrder`). Either one would propagate out of a `view`
    ///      that sits on the path of every deposit and every withdrawal — and the pools
    ///      here are beacon proxies whose implementation can change with no address
    ///      change and no version to pin, which is exactly how a return shape moves under
    ///      you. See SDK feedback issue 16.
    ///
    ///      A revert with a short payload is the pool saying it has no active order under
    ///      this id, which is the answer "nothing is resting here" and worth zero. A
    ///      successful call that does not carry a full order is not an answer at all, and
    ///      is refused rather than quietly priced at zero: a silently understated NAV is
    ///      a discount for the next depositor, paid by the holders already there.
    function _legEscrow(address pool, uint128 orderId, uint256 size, uint256 price)
        internal
        view
        returns (uint256)
    {
        return MarketEngine.costOf(_legRemaining(pool, orderId, size), price, priceOne);
    }

    /// @dev The pool's own `quantityRemaining` for one leg, capped at what was quoted.
    ///      Shared with `reduceQuote` and `completeSet`, which need the quantity rather
    ///      than its cost and must not decode the same eight words a second time.
    function _legRemaining(address pool, uint128 orderId, uint256 size)
        internal
        view
        returns (uint256 remaining)
    {
        if (orderId == 0) return 0;
        (bool ok, bytes memory ret) = pool.staticcall(abi.encodeCall(IBinaryPool.getOrder, (orderId)));
        if (!ok) {
            // `IncorrectOrder()` and friends: a bare selector, or empty. Nothing resting.
            if (ret.length <= 4) return 0;
            revert PoolAnsweredStrangely(pool, orderId);
        }
        // Eight static fields, so a whole order is exactly eight words.
        if (ret.length < 256) revert PoolAnsweredStrangely(pool, orderId);
        assembly { remaining := mload(add(ret, 224)) } // 32 (length) + 6 * 32
        if (remaining > size) remaining = size;
    }

    // ----------------------------------------------------------------- events

    event Quoted(uint256 indexed slot, bytes32 indexed marketId, uint256 bid, uint256 ask, uint256 size);
    event Cancelled(uint256 indexed slot, bytes32 indexed marketId);
    event OperatorSet(address indexed operator);
    event RiskParamsSet(uint16 headroomBps, uint256 minHalfSpread);
    event GridSet(uint256 tickSize, uint256 lotSize);
    event ExposureLimitsSet(uint256 maxQuoteNotional, uint16 maxDeployedBps);
    event NativeSwept(address indexed to, uint256 amount);
    event Settled(uint256 indexed slot, bytes32 indexed marketId, uint256 redeemed, bool voided);
    event Flattened(uint256 indexed slot, bytes32 indexed marketId, uint256 pairs, uint256 returned);
    event Swept(uint256 indexed firesAtMillis, uint256 slotsReleased);
    event GovernanceOffered(address indexed from, address indexed to);
    event GovernanceTransferred(address indexed from, address indexed to);
    event SetCompleted(uint256 indexed slot, bytes32 indexed marketId, uint256 quantity, uint256 spent);
    event QuoteReduced(uint256 indexed slot, bytes32 indexed marketId, uint256 newSize);
    event RedeemDelaySet(uint64 seconds_);

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
    /// @dev One quote tried to commit more than `maxQuoteNotional`.
    error QuoteTooLarge(uint256 escrow, uint256 cap);
    /// @dev This quote would push open escrow past `maxDeployedBps` of NAV.
    error TooMuchDeployed(uint256 wouldBe, uint256 cap);
    /// @dev A withdrawal in the same block as the deposit that funded it. See `_withdraw`.
    error TooSoonAfterDeposit();
    error OrderRejected(uint8 kind);
    error MarketNotSettled(bytes32 marketId, uint8 status);
    error OnlyOperatorWhileTrading(bytes32 marketId);
    error NothingToFlatten(bytes32 marketId);
    error OperatorGrantFailed();
    error NotPendingGovernor(address caller);
    error NotSelf(address caller);
    error LastShareWhileOpen(uint256 slot);
    /// @dev A deposit that would mint no shares at all. See `_deposit`.
    error DepositMintsNothing(uint256 assets);
    /// @dev The pool answered `getOrder` with something that is neither an order nor the
    ///      "no such order" revert. NAV cannot be priced, so nothing is priced.
    error PoolAnsweredStrangely(address pool, uint128 orderId);
    error MarketAlreadyQuoted(bytes32 marketId, uint256 slot);
    error CancelFailed(uint128 orderId, bytes reason);
    /// @dev The pool's own answer for an order id it no longer holds for the caller.
    error IncorrectSender(address caller, address owner);
    /// @dev `completeSet` on a slot whose two sides already match. Nothing is naked.
    error NothingToComplete(bytes32 marketId);
    /// @dev The crossing buy would have cost more than the operator allowed.
    error CompletionTooExpensive(uint256 spent, uint256 cap);
    /// @dev The pool took `reduceOrder` but the id no longer rests at the new size.
    error ReduceNotHonoured(uint128 orderId);
    error SizeNotSmaller(uint256 newSize, uint256 size);
    error DelayTooLong(uint64 requested, uint64 cap);

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
            uint256 pairs_ = yes < no ? yes : no;
            // Cap at what this slot actually quoted. A stranger may transfer outcome
            // tokens to this vault; they are not the vault's to mark.
            total += pairs_ > s.size ? s.size : pairs_;
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
        // Gating on `shares == totalSupply()` was the wrong test: one wei left behind
        // defeats it. The holder is then no longer "the last share" and may exit in full
        // at a NAV that marks the open slot's naked leg at zero, and the slot's proceeds
        // land on whatever dust remains. Measured: a 1-wei holder inheriting 50.00 of a
        // position it paid a wei for, and it fires by accident against any honest last
        // holder who leaves a rounding remainder. Gate on what is LEFT instead.
        if (totalSupply() - shares < MIN_SUPPLY_WHILE_OPEN) {
            for (uint256 i = 0; i < MAX_SLOTS; i++) {
                if (_slots[i].active) revert LastShareWhileOpen(i);
            }
        }
        // Not in the same block as the deposit that funded it.
        //
        // A naked leg is marked at zero, so a WINNING naked leg on an already-resolved
        // market is real, certain, public value that NAV does not show — and `settle` is
        // permissionless, so anyone can pull it in. That made deposit -> settle -> redeem
        // a riskless profit in ONE transaction, funded entirely by the holders already
        // there: measured at +50.00 to the attacker and -50.00 to the existing LP.
        //
        // One block is all it takes to break it, because what made it riskless was
        // atomicity. Across a block boundary the attacker is holding the position, and
        // the mark can move against them like anyone else's. Somnia's blocks are
        // sub-second, so an honest depositor pays effectively nothing for this.
        //
        // It does not close the patient version — deposit, wait, settle, redeem — which
        // is bounded by the risk of holding rather than by this guard. Removing that
        // entirely means not marking a naked leg at zero, which is a larger design
        // decision than a withdrawal guard.
        if (block.timestamp < _depositedAt[owner] + redeemDelay) revert TooSoonAfterDeposit();
        super._withdraw(caller, receiver, owner, assets, shares);
    }

    /// @notice Shares that must remain outstanding while any slot is open.
    /// @dev One whole share at the collateral's scale. Below this the remaining holder is
    ///      dust rather than a depositor, and an open slot's proceeds would settle onto
    ///      it. Withdrawals are unrestricted once every slot is closed.
    uint256 public constant MIN_SUPPLY_WHILE_OPEN = 1e6;

    /// @dev The first-deposit attack is closed here rather than with a decimals offset.
    ///
    ///      An offset of 6 was tried and reverted the same day. It multiplies the share
    ///      scale by 1e6, which silently made `MIN_SUPPLY_WHILE_OPEN` — written as "one
    ///      whole share" — worth one WEI of collateral, so a one-wei deposit landed
    ///      exactly on the floor and the dust guard above stopped guarding anything. It
    ///      also broke every off-chain consumer at once: `scripts/ledger.ts`, `web/app.js`,
    ///      `web/live.js` and `web/ledger.js` all read `assets/supply` as a share price,
    ///      and all of them would have started printing 0.000001. Two fixes written apart
    ///      from each other, each correct alone.
    ///
    ///      What the offset was for was the case where a donation makes the next
    ///      depositor's shares round to zero — a total loss for them. That is what this
    ///      refuses, directly and where it happens. OpenZeppelin's virtual share already
    ///      makes the attack unprofitable for the attacker; this makes it harmless for
    ///      the victim.
    /// @dev `nonReentrant` because this was the one value path without it. `_settle`
    ///      deletes a slot before it receives the collateral for it, so for the length of
    ///      that call NAV understates by exactly the position being redeemed — and a
    ///      module that called back into `deposit` from inside `redeem` would mint shares
    ///      against the understated number and come out worth more than was paid. Not
    ///      reachable today, since `module` is immutable and is the venue's own contract.
    ///      The guard is what keeps it unreachable if that ever stops being true.
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares)
        internal
        override
        nonReentrant
    {
        if (shares == 0) revert DepositMintsNothing(assets);
        _depositedAt[receiver] = block.timestamp;
        super._deposit(caller, receiver, assets, shares);
    }

    /// @notice Timestamp at which each holder's shares were last minted.
    mapping(address holder => uint256 timestamp) private _depositedAt;

    function depositedAt(address holder) external view returns (uint256) {
        return _depositedAt[holder];
    }

    /// @notice How long freshly minted shares must be held before they can be redeemed.
    /// @dev This started as a one-BLOCK guard, and the comment on `_withdraw` said plainly
    ///      what it did not close: "the patient version — deposit, wait, settle, redeem".
    ///      On a chain with sub-second blocks, one block is not a holding period; it is a
    ///      formality a bot clears without noticing. What made the sandwich riskless was
    ///      never atomicity as such, it was that the attacker never carried the mark.
    ///      A real delay makes them carry it.
    ///
    ///      Default 300s, which is the venue's own settlement window: long enough that a
    ///      naked leg's mark can move against whoever is holding it, short enough that an
    ///      honest depositor is not locked in.
    uint64 public redeemDelay = 300;

    /// @notice Ceiling on `redeemDelay`, in seconds.
    /// @dev A governor who could set this without bound could freeze every withdrawal in
    ///      the vault, which is exactly the custody power this contract exists not to
    ///      have. One hour is the most any settlement can justify.
    uint64 public constant MAX_REDEEM_DELAY = 1 hours;

    function setRedeemDelay(uint64 seconds_) external onlyGovernor {
        if (seconds_ > MAX_REDEEM_DELAY) revert DelayTooLong(seconds_, MAX_REDEEM_DELAY);
        redeemDelay = seconds_;
        emit RedeemDelaySet(seconds_);
    }

    /// @notice The most `owner` can actually take out right now.
    /// @dev ERC-4626 requires these to return an amount that does not revert, and the
    ///      inherited versions do not: a withdrawal is paid out of `idleAssets()`, not
    ///      NAV, so anything above idle reverts on the transfer, and the last-share guard
    ///      refuses the rest. The app's own "Max" button trusted the inherited answer and
    ///      sent transactions that could only fail.
    ///      Both return the real maximum rather than zero when a limit binds: a holder
    ///      blocked from taking everything can still take what leaves the floor, and a
    ///      caller is entitled to be told that number rather than to discover it by
    ///      reverting.
    function maxWithdraw(address owner) public view override returns (uint256) {
        // The fresh-deposit guard is a reason a withdrawal reverts, so it belongs here
        // too. Adding that guard without teaching these two about it reintroduced exactly
        // the ERC-4626 violation the paragraph above says they exist to fix — reporting a
        // number that reverts — one commit after fixing it.
        if (block.timestamp < _depositedAt[owner] + redeemDelay) return 0;
        uint256 assets = super.maxWithdraw(owner);
        uint256 idle = idleAssets();
        if (assets > idle) assets = idle;
        uint256 shareCap = _shareCeilingWhileOpen();
        if (shareCap != type(uint256).max) {
            uint256 byShares = convertToAssets(shareCap);
            if (assets > byShares) assets = byShares;
        }
        return assets;
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        if (block.timestamp < _depositedAt[owner] + redeemDelay) return 0;
        uint256 shares = super.maxRedeem(owner);
        uint256 byIdle = convertToShares(idleAssets());
        if (shares > byIdle) shares = byIdle;
        uint256 shareCap = _shareCeilingWhileOpen();
        if (shares > shareCap) shares = shareCap;
        return shares;
    }

    /// @dev The most shares any single holder may burn while a slot is open, so that
    ///      MIN_SUPPLY_WHILE_OPEN is always left behind. `type(uint256).max` when no slot
    ///      is open, which is no constraint at all.
    function _shareCeilingWhileOpen() internal view returns (uint256) {
        for (uint256 i = 0; i < MAX_SLOTS; i++) {
            if (!_slots[i].active) continue;
            uint256 supply = totalSupply();
            return supply > MIN_SUPPLY_WHILE_OPEN ? supply - MIN_SUPPLY_WHILE_OPEN : 0;
        }
        return type(uint256).max;
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
        if (maxQuoteNotional != 0 && escrow > maxQuoteNotional) revert QuoteTooLarge(escrow, maxQuoteNotional);
        if (maxDeployedBps != 0) {
            uint256 wouldBe = totalEscrowed() + escrow;
            uint256 cap = (totalAssets() * maxDeployedBps) / 10_000;
            if (wouldBe > cap) revert TooMuchDeployed(wouldBe, cap);
        }

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

    /// @notice Buy the missing side of a one-sided fill, at market, to close the direction.
    ///
    /// @dev This is the single largest hole in the strategy's economics, and it is not a
    ///      contract bug — it is a missing move. When one leg fills and the book walks
    ///      away from the other, the vault is left holding a direction it never wanted.
    ///      Today it can only cancel the unfilled leg and wait for settlement, where the
    ///      naked side is worth 1 or 0. The ledger has eighteen of these and they cost
    ///      between 6.83 and 76.00 each on a basis under 100.
    ///
    ///      A maker does not wait. It pays the spread to get flat. Holding 100 UP bought
    ///      at 0.218, buying 100 DOWN at 0.78 makes the pair cost 0.998 and the loss is
    ///      two ticks instead of the whole leg. That is what this does: cancel the stale
    ///      resting leg, then cross the book with an IOC for exactly the shortfall.
    ///
    ///      IOC, not LIMIT: what does not cross now must not become a second resting order
    ///      the vault has to manage. A partial fill is a partial success — the naked
    ///      quantity falls by whatever crossed — and the call can be made again.
    ///
    ///      `maxSpend` is the operator's judgement priced on chain. There is no price the
    ///      contract can know is right, but there is a price the vault must never exceed,
    ///      and the caller states it. Above it the whole call reverts and nothing moved.
    ///
    /// @param slot          the open slot holding an uneven position
    /// @param priceYesSide  limit for the crossing order, ALWAYS quoted YES-side
    /// @param maxSpend      hard ceiling on collateral spent, in asset units
    function completeSet(uint256 slot, uint256 priceYesSide, uint256 maxSpend)
        external
        onlyOperator
        nonReentrant
        returns (uint256 filled, uint256 spent)
    {
        if (slot >= MAX_SLOTS) revert SlotOutOfRange(slot);
        Slot storage s = _slots[slot];
        if (!s.active) revert SlotIdle(slot);
        {
            // Past expiry the book is frozen: nothing crosses, and the cancel below would
            // revert anyway. A naked leg there is settlement's problem, not this one's.
            uint8 status = _statusOf(s.marketId);
            if (status != MarketStatus.TRADING) revert MarketNotTrading(s.marketId, status);
        }
        MarketEngine.requireProbability(priceYesSide, priceOne);

        bool needNo;
        uint256 short_;
        {
            uint256 yes = outcomeToken.balanceOf(address(this), s.yesId);
            uint256 no = outcomeToken.balanceOf(address(this), s.noId);
            if (yes == no) revert NothingToComplete(s.marketId);
            needNo = yes > no;
            short_ = needNo ? yes - no : no - yes;
        }

        // The stale leg on the side we are about to buy is the one that failed to fill.
        // Cancel it first: its escrow comes back and pays for the crossing order, and
        // leaving it live would re-open the exposure this call exists to close.
        IBinaryPool pool = IBinaryPool(s.pool);
        if (needNo) {
            if (_cancelIfLive(pool, s.noOrderId, false)) s.noOrderId = 0;
        } else {
            if (_cancelIfLive(pool, s.yesOrderId, false)) s.yesOrderId = 0;
        }

        (filled, spent) = _cross(pool, needNo ? s.noId : s.yesId, needNo, priceYesSide, short_);
        if (spent > maxSpend) revert CompletionTooExpensive(spent, maxSpend);

        // The completion is part of what this episode cost. A basis that stopped at quote
        // time would price the pair against a number the vault did not actually pay.
        s.basis += spent;

        emit SetCompleted(slot, s.marketId, filled, spent);
    }

    /// @notice Shrink both resting legs in place, keeping their queue position.
    ///
    /// @dev Cancel-and-replace loses price-time priority; `reduceOrder` does not. On a
    ///      book that moves under a resting quote, trimming size is the difference
    ///      between staying at the front of the level and going to the back of it, and
    ///      being early is most of what a maker's queue position is worth. The SDK has
    ///      shipped this verb the whole time and no path from an operator key could reach
    ///      it, because every order id this vault owns lives behind its own custody.
    ///
    ///      The pool's own `getOrder` documentation warns that an id can be "replaced by
    ///      a reduce". If that happens the vault has silently lost the handle to its own
    ///      order — escrow would read as zero and the cancel path would have nothing to
    ///      cancel. So this does not trust the call: it reads the leg back, and unless the
    ///      same id is still resting at the new size, the whole transaction reverts and
    ///      the operator falls back to cancel-and-requote. An optimisation that cannot be
    ///      verified is not taken.
    function reduceQuote(uint256 slot, uint256 newSize) external onlyOperator nonReentrant {
        if (slot >= MAX_SLOTS) revert SlotOutOfRange(slot);
        Slot storage s = _slots[slot];
        if (!s.active) revert SlotIdle(slot);
        uint8 status = _statusOf(s.marketId);
        if (status != MarketStatus.TRADING) revert MarketNotTrading(s.marketId, status);

        uint256 qty = MarketEngine.quantize(newSize, lotSize);
        if (qty == 0) revert SizeFlooredToZero();
        if (qty >= s.size) revert SizeNotSmaller(qty, s.size);

        IBinaryPool pool = IBinaryPool(s.pool);
        _reduceLeg(pool, s.yesOrderId, s.size, qty);
        _reduceLeg(pool, s.noOrderId, s.size, qty);

        s.size = qty;
        emit QuoteReduced(slot, s.marketId, qty);
    }

    /// @dev The crossing order, in its own frame.
    ///
    ///      `placeBinaryOrder` takes nine arguments, and inlining it into `completeSet`
    ///      put that function over the EVM's stack limit the moment the optimizer was
    ///      switched off — which is what `forge coverage` does. A function that only
    ///      compiles with the optimizer on is a function nobody can measure.
    ///
    ///      IOC either crosses in this call or it is gone, so the deadline only has to be
    ///      valid, not generous; the market's own expiry is the ceiling regardless.
    function _cross(IBinaryPool pool, uint256 tokenId, bool needNo, uint256 price, uint256 qty)
        internal
        returns (uint256 filled, uint256 spent)
    {
        uint8 kind = needNo ? ORDER_KIND.BUY_NO : ORDER_KIND.BUY_YES;
        {
            // A BUY_NO quoted YES-side at q pays (1 - q) per contract; a BUY_YES pays q.
            uint256 budget =
                MarketEngine.costOf(qty, needNo ? MarketEngine.mirror(price, priceOne) : price, priceOne);
            uint256 idle = idleAssets();
            if (budget > idle) revert InsufficientIdle(budget, idle);
            IERC20(asset()).forceApprove(address(pool), budget);
        }

        uint256 cashBefore = IERC20(asset()).balanceOf(address(this));
        uint256 heldBefore = outcomeToken.balanceOf(address(this), tokenId);

        (bool ok,) = pool.placeBinaryOrder(
            kind,
            price,
            qty,
            MarketEngine.expiryNs(uint64(block.timestamp), uint64(block.timestamp)),
            ORDER_TYPE.IOC,
            0,
            address(0),
            0,
            0
        );
        if (!ok) revert OrderRejected(kind);

        // Whatever did not cross is not resting anywhere, so the approval must not linger.
        IERC20(asset()).forceApprove(address(pool), 0);

        spent = cashBefore - IERC20(asset()).balanceOf(address(this));
        filled = outcomeToken.balanceOf(address(this), tokenId) - heldBefore;
    }

    /// @dev One leg. A leg already at or below the new size is left alone — it has filled
    ///      that far and there is nothing to give back.
    function _reduceLeg(IBinaryPool pool, uint128 orderId, uint256 size, uint256 qty) internal {
        if (orderId == 0) return;
        uint256 remaining = _legRemaining(address(pool), orderId, size);
        if (remaining <= qty) return;
        pool.reduceOrder(orderId, qty);
        if (_legRemaining(address(pool), orderId, size) != qty) revert ReduceNotHonoured(orderId);
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
            // `winningOutcome()` was removed in settlement v3 and now reverts: the market
            // stores a payout VECTOR. This used to take its argmax and redeem that side
            // alone, which is only right when the vector is one-hot. Settlement v3 does
            // not promise that. On a split vector like [7, 3] the smaller side still pays
            // 30% and was abandoned; on a tie [5, 5] with `isVoided() == false` the argmax
            // silently picked index 0 and abandoned the NO side entirely — and the slot is
            // deleted above, so nothing could ever come back for it. Redeem every side
            // that pays anything, exactly as the voided branch already does.
            uint256[] memory payouts = IBinaryMarket(market).payoutNumerators();
            bool paysSomething = (payouts.length > 0 && payouts[0] > 0) || (payouts.length > 1 && payouts[1] > 0);
            // A market that reports resolved with an empty or all-zero vector pays no
            // side at all. Redeeming nothing here would delete the slot and leave the
            // outcome tokens on the ERC-6909 with no function left that can reach them.
            // Refuse instead: the slot survives, and settle can be retried when the
            // market reports a vector that means something.
            if (!paysSomething) revert MarketNotSettled(id, _statusOf(id));
            if (payouts.length > 0 && payouts[0] > 0) _redeemOutcome(id, 0, yesId);
            if (payouts.length > 1 && payouts[1] > 0) _redeemOutcome(id, 1, noId);
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
    ///      precompile's address put that no-op sweep at 1,151,045.
    ///
    ///      Sized for the worst case: MAX_SLOTS slots all taking the dead-oracle path.
    ///      Measured on Shannon at voidExpired 694,993 + settle 679,349 = 1,374,342 per
    ///      slot, so 8 slots is 10,994,736; 16,000,000 covers that with room for the
    ///      per-slot reads and the 1/64 each guarded self-call retains.
    ///
    ///      This was briefly 40,000,000, sized on the since-disproved belief that the
    ///      callback also had to run `syncSettlement` and `finalizeMarket` (3.94M more per
    ///      slot). That number did not even fit its own stated worst case — 8 × 5,314,308
    ///      is 42.5M — and it mattered because only gas used is paid but it is paid from
    ///      the handler's OWN balance: at the 50 gwei cap a full 40M sweep costs 2 STT,
    ///      against a live headroom over MIN_HANDLER_BALANCE of 0.82 STT. One worst-case
    ///      callback would have taken the vault under the floor and it could never have
    ///      armed again. At 16M the same worst case costs 0.8 STT; a real callback has
    ///      measured 291,526 gas, or 0.0047 STT.
    uint64 public constant SWEEP_GAS = 16_000_000;

    /// @dev The fee cap, not the gas limit, is what bounds the worst case — and it is the
    ///      cheaper of the two to lower. `SWEEP_GAS` has to stay wide enough for eight
    ///      slots on the dead-oracle path; the price paid per unit does not.
    ///
    ///      At 50 gwei a full 16M sweep costs 0.8 STT against a live headroom over
    ///      MIN_HANDLER_BALANCE of 0.812 — one bad callback from never arming again, and
    ///      close enough that the keeper's own balance alarm would have fired on nearly
    ///      every run. At 25 gwei the same sweep costs 0.4 and the alarm means something
    ///      when it does fire. Shannon's base fee has run 6-16 gwei throughout, so 25
    ///      still leaves a comfortable multiple; the priority fee is unchanged.
    function armSweep(uint64 firesAtSec) external onlyOperator returns (uint256 subscriptionId) {
        return _arm(uint256(firesAtSec) * 1000, 10 gwei, 25 gwei, SWEEP_GAS);
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
    ///      The hatch writes the market directly, so the module never learns of it, and
    ///      an earlier version of this function followed it with `syncSettlement` and
    ///      `finalizeMarket` on the belief that redemption would otherwise find an empty
    ///      settlement. Measured on a fork against the real module, that is false: after
    ///      a bare `voidExpired`, `settle` redeemed 100.000000 of 100. Those two calls
    ///      cost 3.94M of gas between them, which is most of what a slot needs here, and
    ///      the sweep pays for its own gas out of a balance that must stay above
    ///      MIN_HANDLER_BALANCE. So they are gone from the callback. The bot still makes
    ///      both from off-chain, where gas is the operator's and belt-and-braces is free.
    ///      If redemption ever does need them, `_settle` reverts, this slot's guarded
    ///      call is caught, and the bot closes it on the next cycle — the failure is a
    ///      delay, not a loss.
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

    /// @notice Set the exposure caps. Either may be 0, which disables that one.
    function setExposureLimits(uint256 maxQuoteNotional_, uint16 maxDeployedBps_) external onlyGovernor {
        maxQuoteNotional = maxQuoteNotional_;
        maxDeployedBps = maxDeployedBps_;
        emit ExposureLimitsSet(maxQuoteNotional_, maxDeployedBps_);
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
