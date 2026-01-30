#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=========================================="
echo "=== Step 2: Populating State ==="
echo "=========================================="
echo ""

if [ ! -f ./source-info.json ]; then
    echo "Error: source-info.json not found. Run 1_start_source.sh first."
    exit 1
fi

RPC_URL=$(jq -r '.rpcUrl' ./source-info.json)
echo "RPC URL: $RPC_URL"
echo ""

# Target address: 0x1111...1111 (all ones, not zero address)
TARGET_ADDRESS="0x1111111111111111111111111111111111111111"

# Large amount to make transplant obvious
NATIVE_AMOUNT="100000000000000000000000"  # 100,000 ETH

echo "Target address: $TARGET_ADDRESS"
echo ""

# ============================================
# Send Native ETH
# ============================================
echo "--- Sending Native ETH ---"
echo "Amount: 100,000 ETH ($NATIVE_AMOUNT wei)"
echo ""

BALANCE_BEFORE=$(go run ./cmd/balance "$RPC_URL" "$TARGET_ADDRESS")
echo "Native balance BEFORE: $BALANCE_BEFORE wei"

go run ./cmd/sendtx "$RPC_URL" "$TARGET_ADDRESS" "$NATIVE_AMOUNT"

echo "Waiting 3 seconds for confirmation..."
sleep 3

BALANCE_AFTER=$(go run ./cmd/balance "$RPC_URL" "$TARGET_ADDRESS")
echo "Native balance AFTER:  $BALANCE_AFTER wei"

# ============================================
# Save state for verification
# ============================================
echo ""
echo "--- Saving State Info ---"

echo "$TARGET_ADDRESS" > ./target-address.txt
echo "$BALANCE_AFTER" > ./expected-native-balance.txt

echo ""
echo "=========================================="
echo "State populated successfully!"
echo ""
echo "Target Address:     $TARGET_ADDRESS"
echo "Native Balance:     $BALANCE_AFTER wei (100,000 ETH)"
echo "=========================================="
echo ""
echo "Run ./3_stop_source.sh next."
