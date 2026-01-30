#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=========================================="
echo "=== Step 8: Verifying Transplanted State ==="
echo "=========================================="
echo ""

if [ ! -f ./fuji-info.json ]; then
    echo "Error: fuji-info.json not found. Run steps 1-7 first."
    exit 1
fi

RPC_URL=$(jq -r '.rpcUrl' ./fuji-info.json)
SOURCE_CHAIN_ID=$(cat ./source-chain-id.txt)
TARGET_CHAIN_ID=$(jq -r '.chainId' ./fuji-info.json)
TARGET_SUBNET_ID=$(jq -r '.subnetId' ./fuji-info.json)

echo "Source Network:  Local DevNet"
echo "Target Network:  Fuji Testnet"
echo ""
echo "Source Chain ID: $SOURCE_CHAIN_ID"
echo "Target Chain ID: $TARGET_CHAIN_ID"
echo "Target Subnet:   $TARGET_SUBNET_ID"
echo "RPC URL:         $RPC_URL"
echo ""

# Container name for the validator
VALIDATOR_CONTAINER="fuji_validator"

# Check if node is bootstrapped first
echo "Checking if node is bootstrapped..."
IS_BOOTSTRAPPED=$(curl -s -X POST -H "Content-Type: application/json" \
    --data '{"jsonrpc":"2.0","method":"info.isBootstrapped","params":{"chain":"P"},"id":1}' \
    "http://127.0.0.1:9750/ext/info" 2>/dev/null | jq -r '.result.isBootstrapped' 2>/dev/null)

if [ "$IS_BOOTSTRAPPED" != "true" ]; then
    echo "WARNING: Node is not yet bootstrapped on P-Chain."
    echo "The node needs to sync with Fuji before the L1 chain will be available."
    echo ""
    echo "Please wait for bootstrapping to complete and try again."
    echo "You can monitor bootstrap progress with: docker logs -f $VALIDATOR_CONTAINER"
    exit 1
fi

echo "Node is bootstrapped!"
echo ""

TARGET_ADDRESS=$(cat ./target-address.txt)
EXPECTED_NATIVE=$(cat ./expected-native-balance.txt)

echo "Target Address:  $TARGET_ADDRESS"
echo ""

# ============================================
# Check Native Balance
# ============================================
echo "--- Checking Native Balance ---"
echo "Expected: $EXPECTED_NATIVE wei"

ACTUAL_NATIVE=$(go run ./cmd/balance "$RPC_URL" "$TARGET_ADDRESS" 2>/dev/null)

if [ -z "$ACTUAL_NATIVE" ]; then
    echo "Error: Could not get balance. Chain may not be ready yet."
    echo "Check if the L1 chain is running: curl $RPC_URL -X POST -H 'Content-Type: application/json' --data '{\"jsonrpc\":\"2.0\",\"method\":\"eth_blockNumber\",\"id\":1}'"
    exit 1
fi

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
    echo "SUCCESS! Cross-Network State Transplant Verified!"
    echo ""
    echo "State was successfully transplanted:"
    echo "  FROM: Local DevNet (chain $SOURCE_CHAIN_ID)"
    echo "  TO:   Fuji Testnet L1 (chain $TARGET_CHAIN_ID)"
    echo ""
    echo "Native ETH balance: $ACTUAL_NATIVE wei"
else
    echo "FAILED! State mismatch detected."
    exit 1
fi
echo "=========================================="
echo ""
echo "Run ./9_post_transplant_tx.sh to test transaction gossip via the RPC node."
