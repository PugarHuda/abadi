// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {AbadiReactive} from "../src/AbadiReactive.sol";
import {SomniaExtensions} from "@somnia-chain/reactivity-contracts/contracts/interfaces/SomniaExtensions.sol";
import {ISomniaEventHandler} from "@somnia-chain/reactivity-contracts/contracts/interfaces/ISomniaEventHandler.sol";
import {ISomniaReactivityPrecompile} from
    "@somnia-chain/reactivity-contracts/contracts/interfaces/ISomniaReactivityPrecompile.sol";
import {IERC165} from "@somnia-chain/reactivity-contracts/contracts/interfaces/IERC165.sol";

contract Roller is AbadiReactive {
    uint256 public lastFiredAt;
    uint256 public fireCount;

    function _onScheduled(uint256 firesAtMillis) internal override {
        lastFiredAt = firesAtMillis;
        fireCount++;
    }

    function exposedArm(uint256 whenMs) external returns (uint256) {
        return _arm(whenMs, 10 gwei, 50 gwei, 500_000);
    }

    function exposedDisarm(uint256 whenMs) external {
        _disarm(whenMs);
    }
}

/// @dev The precompile does not exist on anvil, so arming cannot be exercised locally.
///      What CAN be pinned here is everything that guards the arming call — the funding
///      floor, the callback authorisation, topic validation, and one-shot semantics.
///      Arming itself is proven on a Shannon fork; see docs/evidence.
contract AbadiReactiveTest is Test {
    Roller roller;
    uint256 constant AT = 1_800_000_000_000; // some future ms
    address constant PRECOMPILE = SomniaExtensions.SOMNIA_REACTIVITY_PRECOMPILE_ADDRESS;

    function setUp() public {
        roller = new Roller();
    }

    // ------------------------------------------------------------- funding

    /// The precompile rejects an underfunded handler with EMPTY revert data, which is
    /// indistinguishable from a malformed subscription. This turns it into a named error.
    /// Discovered the hard way: a probe funded with 5 STT failed for hours before the
    /// Somnia team pointed at the 32 STT floor.
    function test_underfundedHandlerFailsWithAReadableReason() public {
        assertEq(address(roller).balance, 0);
        vm.expectRevert(abi.encodeWithSelector(AbadiReactive.Underfunded.selector, uint256(0), 32 ether));
        roller.requireFunded();

        vm.deal(address(roller), 31.9 ether);
        vm.expectRevert(
            abi.encodeWithSelector(AbadiReactive.Underfunded.selector, uint256(31.9 ether), 32 ether)
        );
        roller.requireFunded();

        vm.deal(address(roller), 32 ether);
        roller.requireFunded(); // exactly the floor is enough
    }

    function test_handlerAcceptsNativeFunding() public {
        (bool ok,) = address(roller).call{value: 33 ether}("");
        assertTrue(ok, "receive() must accept the gas reserve");
        assertEq(address(roller).balance, 33 ether);
    }

    // -------------------------------------------------------------- erc165

    /// The precompile uses ERC-165 to decide whether an address can receive callbacks.
    /// A hand-rolled handler that omits this is refused — the second cause of our
    /// original failure, hidden behind the same empty revert as the funding floor.
    function test_answersErc165ForTheHandlerInterface() public view {
        assertTrue(roller.supportsInterface(type(ISomniaEventHandler).interfaceId), "handler iface");
        assertTrue(roller.supportsInterface(type(IERC165).interfaceId), "erc165 itself");
        assertFalse(roller.supportsInterface(0xdeadbeef), "unknown iface");
    }

    // ------------------------------------------------------------ callback

    function test_onlyThePrecompileCanFireTheCallback() public {
        vm.expectRevert(); // OnlyReactivityPrecompile, raised by the Somnia base
        roller.onEvent(PRECOMPILE, _scheduleTopics(AT), "");
        assertEq(roller.fireCount(), 0);
    }

    function test_rejectsATopicThatIsNotASchedule() public {
        bytes32[] memory topics = new bytes32[](2);
        topics[0] = ISomniaReactivityPrecompile.BlockTick.selector;
        topics[1] = bytes32(AT);

        vm.prank(PRECOMPILE);
        vm.expectRevert(abi.encodeWithSelector(AbadiReactive.UnexpectedTopic.selector, topics[0]));
        roller.onEvent(PRECOMPILE, topics, "");
    }

    function test_firesOnceAndCarriesTheInstantThrough() public {
        vm.prank(PRECOMPILE);
        roller.onEvent(PRECOMPILE, _scheduleTopics(AT), "");

        assertEq(roller.fireCount(), 1, "fired once");
        assertEq(roller.lastFiredAt(), AT, "carried the instant through");
        assertEq(roller.armed(AT), 0, "one-shot: cleared, and it does not re-arm itself");
    }

    function test_disarmingSomethingNeverArmedReverts() public {
        vm.expectRevert(abi.encodeWithSelector(AbadiReactive.NotArmed.selector, AT));
        roller.exposedDisarm(AT);
    }

    function _scheduleTopics(uint256 at_) internal pure returns (bytes32[] memory topics) {
        topics = new bytes32[](2);
        topics[0] = ISomniaReactivityPrecompile.Schedule.selector;
        topics[1] = bytes32(at_);
    }
}
