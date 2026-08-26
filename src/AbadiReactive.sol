// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SomniaEventHandler} from "@somnia-chain/reactivity-contracts/contracts/SomniaEventHandler.sol";
import {SomniaExtensions} from "@somnia-chain/reactivity-contracts/contracts/interfaces/SomniaExtensions.sol";
import {ISomniaReactivityPrecompile} from
    "@somnia-chain/reactivity-contracts/contracts/interfaces/ISomniaReactivityPrecompile.sol";

/// @title AbadiReactive
/// @notice Base for a contract that wakes itself at a wall-clock instant with no keeper.
///
/// @dev Mechanism: subscribe to the reactivity precompile's own `Schedule` tick, filtered
///      to one exact millisecond. When that instant arrives the precompile calls back into
///      this contract. Confirmed by the Somnia team: subscription creation is
///      permissionless and live on both testnet and mainnet.
///
///      Three requirements that are NOT obvious, each of which cost us a real debugging
///      session, and none of which produce a useful revert reason:
///
///      1. The handler must hold at least 32 STT on testnet. Below that the precompile
///         rejects `subscribe` with empty data. `requireFunded` turns that into a named
///         error instead of a silent one.
///      2. The handler must answer ERC-165 for `ISomniaEventHandler`. The precompile uses
///         it to decide whether an address can receive callbacks. `SomniaEventHandler`
///         provides this; a hand-rolled handler that omits it is refused.
///      3. `maxFeePerGas` must sit at least 6 gwei above `priorityFeePerGas`, and
///         `gasLimit` must be in (0, 200_000_000].
///
///      The precompile has no bytecode, so a plain external call to it reverts on solc's
///      EXTCODESIZE guard before the call is made. `SomniaExtensions` handles that; do
///      not reach for the interface directly.
///
///      None of this path exists on local anvil. Every test of it must fork Shannon.
abstract contract AbadiReactive is SomniaEventHandler {
    /// @dev Precompile-enforced minimum handler balance on testnet.
    uint256 public constant MIN_HANDLER_BALANCE = 32 ether;

    /// @notice Subscription id currently armed, keyed by the millisecond it fires at.
    mapping(uint256 firesAtMillis => uint256 subscriptionId) public armed;

    event Armed(uint256 indexed firesAtMillis, uint256 indexed subscriptionId);
    event Disarmed(uint256 indexed firesAtMillis, uint256 indexed subscriptionId);
    event CallbackFired(uint256 indexed firesAtMillis);

    error Underfunded(uint256 balance, uint256 required);
    error AlreadyArmed(uint256 firesAtMillis);
    error NotArmed(uint256 firesAtMillis);
    error UnexpectedTopic(bytes32 topic0);

    /// @notice Reverts with a readable reason instead of the precompile's empty revert.
    /// @dev The failure this prevents is genuinely hard to diagnose: an underfunded
    ///      handler and a malformed subscription fail identically, with no return data.
    function requireFunded() public view {
        if (address(this).balance < MIN_HANDLER_BALANCE) {
            revert Underfunded(address(this).balance, MIN_HANDLER_BALANCE);
        }
    }

    /// @notice Arm a one-shot wake-up at `firesAtMillis`.
    /// @dev Re-arming an instant already armed is rejected rather than silently replaced:
    ///      a duplicate subscription would fire the same roll twice.
    function _arm(uint256 firesAtMillis, uint64 priorityFeePerGas, uint64 maxFeePerGas, uint64 gasLimit)
        internal
        returns (uint256 subscriptionId)
    {
        requireFunded();
        if (armed[firesAtMillis] != 0) revert AlreadyArmed(firesAtMillis);

        subscriptionId = SomniaExtensions.scheduleSubscriptionAtTimestamp(
            address(this),
            firesAtMillis,
            SomniaExtensions.SubscriptionOptions({
                priorityFeePerGas: priorityFeePerGas,
                maxFeePerGas: maxFeePerGas,
                gasLimit: gasLimit
            })
        );

        armed[firesAtMillis] = subscriptionId;
        emit Armed(firesAtMillis, subscriptionId);
    }

    /// @notice Cancel a pending wake-up.
    function _disarm(uint256 firesAtMillis) internal {
        uint256 subscriptionId = armed[firesAtMillis];
        if (subscriptionId == 0) revert NotArmed(firesAtMillis);
        delete armed[firesAtMillis];
        SomniaExtensions.unsubscribe(subscriptionId);
        emit Disarmed(firesAtMillis, subscriptionId);
    }

    /// @dev Called by the base only after it has verified the precompile is the caller.
    ///      A callback that reverts is lost, so `_onScheduled` must never let ordinary
    ///      business failure bubble out — park the position instead.
    function _onEvent(address, bytes32[] calldata eventTopics, bytes calldata) internal override {
        if (eventTopics.length < 2 || eventTopics[0] != ISomniaReactivityPrecompile.Schedule.selector) {
            revert UnexpectedTopic(eventTopics.length == 0 ? bytes32(0) : eventTopics[0]);
        }

        uint256 firesAtMillis = uint256(eventTopics[1]);
        // One-shot: the subscription is spent once it fires and does NOT re-arm itself.
        delete armed[firesAtMillis];
        emit CallbackFired(firesAtMillis);

        _onScheduled(firesAtMillis);
    }

    /// @notice Called when an armed instant arrives. Implement the roll here.
    function _onScheduled(uint256 firesAtMillis) internal virtual;

    /// @notice Recover the native gas reserve.
    /// @dev Deliberately present. An earlier version of this contract had `receive()` and
    ///      no way out, which stranded 20 STT across three throwaway probes on Shannon.
    ///      A contract that must hold >= 32 STT to function needs an exit by construction.
    ///      Exposure is left to the subclass: it decides who may call this.
    function _sweepNative(address payable to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        require(ok, "sweep failed");
    }

    /// @notice Funds the callback gas reserve.
    receive() external payable {}
}
