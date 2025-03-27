#!/bin/bash
set -exu -o pipefail

SCRIPT_DIR=$(dirname "$0")
# Convert to absolute path
SCRIPT_DIR=$(cd "$SCRIPT_DIR" && pwd)

# Create temporary directory
TMP_DIR="/tmp/contract-compile"
mkdir -p "$TMP_DIR"

# Compile the contract
docker run --rm \
    -v "$SCRIPT_DIR/:/contracts" \
    -v "$TMP_DIR:/tmp/output" \
    ethereum/solc:0.8.29-alpine \
    --abi --bin /contracts/GasGuzzler.sol -o /tmp/output

# Generate Go bindings
docker run --rm \
    -v "$SCRIPT_DIR/:/contracts" \
    -v "$TMP_DIR:/tmp/output" \
    ethereum/client-go:alltools-release-1.15 \
    abigen --bin=/tmp/output/GasGuzzler.bin --abi=/tmp/output/GasGuzzler.abi --pkg=contracts --out=/contracts/GasGuzzler.go

# Clean up temporary files
rm -rf "$TMP_DIR"

sudo chmod 777 "$SCRIPT_DIR/GasGuzzler.go"
