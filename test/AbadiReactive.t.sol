// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {AbadiReactive} from "../src/AbadiReactive.sol";
import {SomniaExtensions} from "@somnia-chain/reactivity-contracts/contracts/interfaces/SomniaExtensions.sol";
import {ISomniaEventHandler} from "@somnia-chain/reactivity-contracts/contracts/interfaces/ISomniaEventHandler.sol";
import {ISomniaReactivityPrecompile} from
    "@somnia-chain/reactivity-contracts/contracts/interfaces/ISomniaReactivityPrecompile.sol";
import {IERC165} from "@somnia-chain/reactivity-contracts/contracts/interfaces/IERC165.sol";
import {PrecompileStub, STUB_SUBSCRIPTION_ID} from "./LiquidityVault.t.sol";

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

    // -------------------------------------------------------------- arming

    /// `exposedArm` existed and was never called from anywhere: the arming path had no
    /// coverage at all, here or on a fork. The reason is real — the precompile is node
    /// code with no bytecode, so a typed call to it reverts on solc's EXTCODESIZE guard
    /// before the call is even made — but "cannot be run" is not the same as "cannot be
    /// tested". Etching a stub at its fixed address makes the path executable, and
    /// everything on this side of it is the code that actually ships: the 32 STT floor,
    /// the refusal to arm one instant twice, the bookkeeping, and the Somnia library's
    /// own timestamp, fee-gap and gas-limit checks.
    function test_armingClaimsTheInstantAndDisarmingGivesItBack() public {
        vm.etch(PRECOMPILE, address(new PrecompileStub()).code);

        // The floor is checked by `_arm` itself, not only by the public `requireFunded`.
        vm.expectRevert(abi.encodeWithSelector(AbadiReactive.Underfunded.selector, uint256(0), 32 ether));
        roller.exposedArm(AT);

        vm.deal(address(roller), 33 ether);
        vm.expectEmit(true, true, false, false);
        emit AbadiReactive.Armed(AT, STUB_SUBSCRIPTION_ID);
        uint256 id = roller.exposedArm(AT);

        assertEq(id, STUB_SUBSCRIPTION_ID, "the precompile's id comes back to the caller");
        assertEq(roller.armed(AT), id, "and is recorded against the instant it fires at");

        // A duplicate subscription on one instant fires the same sweep twice.
        vm.expectRevert(abi.encodeWithSelector(AbadiReactive.AlreadyArmed.selector, AT));
        roller.exposedArm(AT);

        vm.expectEmit(true, true, false, false);
        emit AbadiReactive.Disarmed(AT, id);
        roller.exposedDisarm(AT);
        assertEq(roller.armed(AT), 0, "the instant is free again");
        roller.exposedArm(AT); // and provably so
    }

    /// The library refuses an instant that has already passed, which is the shape a bot
    /// arming "expiry + settlementWindow" produces the moment it runs a little late.
    function test_armingAnInstantAlreadyGoneIsRefused() public {
        vm.etch(PRECOMPILE, address(new PrecompileStub()).code);
        vm.deal(address(roller), 33 ether);
        vm.warp(2_000_000_000);
        vm.expectRevert(SomniaExtensions.TimestampInPast.selector);
        roller.exposedArm(AT); // AT is 1.8e12 ms = well behind `now`
        assertEq(roller.armed(AT), 0, "and nothing was recorded for it");
    }

    function test_disarmingSomethingNeverArmedReverts() public {
        vm.expectRevert(abi.encodeWithSelector(AbadiReactive.NotArmed.selector, AT));
        roller.exposedDisarm(AT);
    }

    /// Measured on Shannon: armed for ...245000, the callback's topic said ...245060. The
    /// precompile reports the millisecond it actually ran, not the one that was asked
    /// for. The arm must still be found and cleared, and the sweep must still run.
    function test_aCallbackSixtyMillisecondsLateStillClearsTheArm() public {
        // Plant the arm directly: the precompile does not exist here, so `_arm` cannot.
        vm.store(address(roller), keccak256(abi.encode(AT, uint256(0))), bytes32(uint256(777)));
        assertEq(roller.armed(AT), 777, "planted");

        vm.prank(PRECOMPILE);
        roller.onEvent(PRECOMPILE, _scheduleTopics(AT + 60), "");

        assertEq(roller.fireCount(), 1, "the sweep ran");
        assertEq(roller.lastFiredAt(), AT, "keyed by the second that was armed, not the jittered one");
        assertEq(roller.armed(AT), 0, "cleared despite the jitter");
    }

    function _scheduleTopics(uint256 at_) internal pure returns (bytes32[] memory topics) {
        topics = new bytes32[](2);
        topics[0] = ISomniaReactivityPrecompile.Schedule.selector;
        topics[1] = bytes32(at_);
    }
}
