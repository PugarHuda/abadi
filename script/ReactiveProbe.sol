// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AbadiReactive} from "../src/AbadiReactive.sol";

/// @notice Proves the keeper-free wake-up end to end on Shannon. Not part of the protocol.
contract ReactiveProbe is AbadiReactive {
    address public immutable owner;

    uint256 public fireCount;
    uint256 public lastFiredAtMillis;
    uint256 public lastBlockTimestamp;

    constructor() payable {
        owner = msg.sender;
    }

    function arm(uint64 delaySeconds) external returns (uint256) {
        // The helper requires strictly more than (block.timestamp + 1) * 1000.
        return _arm((block.timestamp + delaySeconds) * 1000, 10 gwei, 50 gwei, 500_000);
    }

    function disarm(uint256 whenMs) external {
        _disarm(whenMs);
    }

    /// @dev The exit that the first version of this probe lacked.
    function sweep() external {
        require(msg.sender == owner, "not owner");
        _sweepNative(payable(owner), address(this).balance);
    }

    function _onScheduled(uint256 firesAtMillis) internal override {
        fireCount++;
        lastFiredAtMillis = firesAtMillis;
        lastBlockTimestamp = block.timestamp;
    }
}
