// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title GasBurner — CPU-only gas consumer
/// @notice Temporary defense contract. Burns gas via keccak256 loops.
///         Single state variable (lastHash) — no state growth.
///         No events. No logs. Just CPU.
contract GasBurner {
    bytes32 public lastHash;

    /// @notice Burns gas by running `iterations` keccak256 hashes.
    /// @param iterations Number of hash iterations to perform.
    function burn(uint256 iterations) external {
        bytes32 h = keccak256(abi.encodePacked(iterations));
        for (uint256 i = 0; i < iterations; ) {
            h = keccak256(abi.encodePacked(h));
            unchecked { ++i; }
        }
        lastHash = h;
    }
}
