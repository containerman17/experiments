#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=========================================="
echo "=== Step 5: Verifying Transplanted State ==="
echo "=========================================="
echo ""

if [ ! -f ./target-info.json ]; then
    echo "Error: target-info.json not found. Run steps 1-4 first."
    exit 1
fi

RPC_URL=$(jq -r '.rpcUrl' ./target-info.json)
SOURCE_CHAIN_ID=$(cat ./source-chain-id.txt)
TARGET_CHAIN_ID=$(jq -r '.chainId' ./target-info.json)

echo "Source Chain ID: $SOURCE_CHAIN_ID"
echo "Target Chain ID: $TARGET_CHAIN_ID"
echo "RPC URL: $RPC_URL"
echo ""

if [ "$SOURCE_CHAIN_ID" = "$TARGET_CHAIN_ID" ]; then
    echo "WARNING: Chain IDs are the same! This shouldn't happen."
fi

TARGET_ADDRESS=$(cat ./target-address.txt)
EXPECTED_NATIVE=$(cat ./expected-native-balance.txt)

echo "Target Address:  $TARGET_ADDRESS"
echo ""

# ============================================
# Check Native Balance
# ============================================
echo "--- Checking Native Balance ---"
echo "Expected: $EXPECTED_NATIVE wei"

ACTUAL_NATIVE=$(go run ./cmd/balance "$RPC_URL" "$TARGET_ADDRESS")
echo "Actual:   $ACTUAL_NATIVE wei"

if [ "$ACTUAL_NATIVE" = "$EXPECTED_NATIVE" ]; then
    echo "NATIVE: OK"
    NATIVE_OK=true
else
    echo "NATIVE: MISMATCH!"
    NATIVE_OK=false
fi

# ============================================
# Summary
# ============================================
echo ""
echo "=========================================="
if [ "$NATIVE_OK" = true ]; then
    echo "SUCCESS! State transplant verified!"
    echo ""
    echo "Native ETH balance was successfully"
    echo "transplanted from chain $SOURCE_CHAIN_ID"
    echo "to chain $TARGET_CHAIN_ID"
else
    echo "FAILED! State mismatch detected."
    exit 1
fi
echo "=========================================="
echo ""
echo "Run ./6_bootstrap_rpc.sh to test RPC node bootstrapping."
