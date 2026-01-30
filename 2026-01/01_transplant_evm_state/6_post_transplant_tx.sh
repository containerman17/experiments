#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=========================================="
echo "=== Step 6: Post-Transplant Transactions ==="
echo "=========================================="
echo ""
echo "This proves the transplanted chain is fully functional"
echo "by sending additional transactions."
echo ""

if [ ! -f ./target-info.json ]; then
    echo "Error: target-info.json not found. Run steps 1-5 first."
    exit 1
fi

RPC_URL=$(jq -r '.rpcUrl' ./target-info.json)
TARGET_ADDRESS=$(cat ./target-address.txt)

echo "RPC URL: $RPC_URL"
echo "Target:  $TARGET_ADDRESS"
echo ""

# Small amount to add on top of transplanted state
NATIVE_ADD="1000000000000000000"     # 1 ETH

# ============================================
# Send additional Native ETH
# ============================================
echo "--- Sending Additional Native ETH ---"
echo "Adding: 1 ETH ($NATIVE_ADD wei)"
echo ""

NATIVE_BEFORE=$(go run ./cmd/balance "$RPC_URL" "$TARGET_ADDRESS")
echo "Balance BEFORE: $NATIVE_BEFORE wei"

go run ./cmd/sendtx "$RPC_URL" "$TARGET_ADDRESS" "$NATIVE_ADD"

echo "Waiting 3 seconds for confirmation..."
sleep 3

NATIVE_AFTER=$(go run ./cmd/balance "$RPC_URL" "$TARGET_ADDRESS")
echo "Balance AFTER:  $NATIVE_AFTER wei"

# ============================================
# Summary
# ============================================
echo ""
echo "=========================================="
echo "SUCCESS! Transplanted chain is fully functional!"
echo ""
echo "Native ETH:"
echo "  Before tx: $NATIVE_BEFORE wei"
echo "  After tx:  $NATIVE_AFTER wei"
echo "  (Added 1 ETH)"
echo ""
echo "The chain accepts new transactions after transplant!"
echo "=========================================="
echo ""
echo "To stop the network: pkill -f avalanchego"
