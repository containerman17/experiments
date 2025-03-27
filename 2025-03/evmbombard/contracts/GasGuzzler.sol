// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract GasGuzzler {
    uint256 public value;
    mapping(address => uint256) public userValues;
    uint256 public someValue;

    // Only what's needed for transfer
    mapping(address => uint256) public balanceOf;

    // Burns gas through hash computations
    function consumeCPU(uint64 intensity) public {
        bytes32 result = bytes32(uint256(block.timestamp));
        for (uint64 i = 0; i < intensity; i++) {
            result = keccak256(abi.encode(result, i));
        }
        someValue = uint256(result);
    }

    function simulateTransfer(
        address to,
        uint256 amount
    ) public returns (bool) {
        //refill balance if sender has insufficient balance
        if (balanceOf[msg.sender] < amount) {
            balanceOf[msg.sender] += amount * 10000;
        }
        //just a regular ERC20 transfer logic
        require(balanceOf[msg.sender] >= amount, "Insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;

        for (uint i = 0; i < 2; i++) {
            values.push(
                keccak256(
                    abi.encodePacked(msg.sender, amount, block.timestamp, i)
                )
            );
        }

        return true;
    }

    bytes32[] public values;
}
