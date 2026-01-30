#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=========================================="
echo "=== Step 9: Test Transaction Gossip ==="
echo "=========================================="
echo ""
echo "This test submits a transaction via the RPC node (not the validator)"
echo "to verify that transaction gossip works correctly across the network."
echo ""

if [ ! -f ./fuji-info.json ]; then
    echo "Error: fuji-info.json not found. Run steps 1-8 first."
    exit 1
fi

# Get RPC node URL (where we'll submit the tx)
RPC_NODE_URL=$(jq -r '.rpcNodeUrl' ./fuji-info.json)
if [ -z "$RPC_NODE_URL" ] || [ "$RPC_NODE_URL" = "null" ]; then
    echo "Error: rpcNodeUrl not found in fuji-info.json"
    echo "Run 7_bootstrap_rpc.sh first to start the RPC node."
    exit 1
fi

# Get validator URL (where we'll verify the tx was gossiped)
FUJI_CHAIN_ID=$(jq -r '.chainId' ./fuji-info.json)
VALIDATOR_URL="http://127.0.0.1:9750/ext/bc/$FUJI_CHAIN_ID/rpc"

TARGET_ADDRESS=$(cat ./target-address.txt)

echo "Network:        Fuji Testnet"
echo "Chain ID:       $FUJI_CHAIN_ID"
echo ""
echo "Submit via:     RPC Node     ($RPC_NODE_URL)"
echo "Verify on:      Validator    ($VALIDATOR_URL)"
echo ""
echo "Target Address: $TARGET_ADDRESS"
echo ""

# Small amount to send
NATIVE_ADD="1000000000000000000"     # 1 ETH

# ============================================
# Check balances before
# ============================================
echo "--- Checking Balances Before Transaction ---"
echo ""

RPC_BALANCE_BEFORE=$(go run ./cmd/balance "$RPC_NODE_URL" "$TARGET_ADDRESS" 2>/dev/null)
VALIDATOR_BALANCE_BEFORE=$(go run ./cmd/balance "$VALIDATOR_URL" "$TARGET_ADDRESS" 2>/dev/null)

echo "RPC Node balance:   $RPC_BALANCE_BEFORE wei"
echo "Validator balance:  $VALIDATOR_BALANCE_BEFORE wei"

if [ "$RPC_BALANCE_BEFORE" != "$VALIDATOR_BALANCE_BEFORE" ]; then
    echo "Warning: Balances differ - nodes may not be fully synced"
fi

# ============================================
# Send transaction via RPC node
# ============================================
echo ""
echo "--- Sending Transaction via RPC Node ---"
echo "Amount: 1 ETH ($NATIVE_ADD wei)"
echo ""

go run ./cmd/sendtx "$RPC_NODE_URL" "$TARGET_ADDRESS" "$NATIVE_ADD"

echo ""
echo "Waiting for transaction to be gossiped and confirmed..."
sleep 5

# ============================================
# Verify on both nodes
# ============================================
echo ""
echo "--- Verifying Transaction on Both Nodes ---"
echo ""

RPC_BALANCE_AFTER=$(go run ./cmd/balance "$RPC_NODE_URL" "$TARGET_ADDRESS" 2>/dev/null)
VALIDATOR_BALANCE_AFTER=$(go run ./cmd/balance "$VALIDATOR_URL" "$TARGET_ADDRESS" 2>/dev/null)

echo "RPC Node balance:   $RPC_BALANCE_AFTER wei"
echo "Validator balance:  $VALIDATOR_BALANCE_AFTER wei"

# ============================================
# Summary
# ============================================
echo ""
echo "=========================================="

GOSSIP_OK=true

if [ "$RPC_BALANCE_AFTER" = "$RPC_BALANCE_BEFORE" ]; then
    echo "ERROR: RPC node balance unchanged - transaction may have failed"
    GOSSIP_OK=false
fi

if [ "$VALIDATOR_BALANCE_AFTER" = "$VALIDATOR_BALANCE_BEFORE" ]; then
    echo "ERROR: Validator balance unchanged - gossip may have failed"
    GOSSIP_OK=false
fi

if [ "$RPC_BALANCE_AFTER" != "$VALIDATOR_BALANCE_AFTER" ]; then
    echo "WARNING: Balances differ between nodes"
    echo "  RPC Node:   $RPC_BALANCE_AFTER"
    echo "  Validator:  $VALIDATOR_BALANCE_AFTER"
    echo "Nodes may need more time to sync."
fi

if [ "$GOSSIP_OK" = true ]; then
    echo "SUCCESS! Transaction Gossip Working!"
    echo ""
    echo "Transaction submitted via RPC node was:"
    echo "  1. Accepted by RPC node"
    echo "  2. Gossiped to validator"
    echo "  3. Included in block"
    echo "  4. Synced back to RPC node"
    echo ""
    echo "Balance change: +1 ETH"
    echo "  Before: $RPC_BALANCE_BEFORE wei"
    echo "  After:  $RPC_BALANCE_AFTER wei"
fi

echo "=========================================="
echo ""
echo "Cross-network state transplant test complete!"
echo ""
echo "To stop all Fuji nodes:"
echo "  docker stop fuji_validator fuji_rpc"
echo "  docker rm fuji_validator fuji_rpc"
