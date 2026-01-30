#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=========================================="
echo "=== Step 6: Bootstrap RPC Node ==="
echo "=========================================="
echo ""
echo "This starts a fresh RPC node with random credentials"
echo "that must sync from scratch with the L1 validator."
echo ""

if [ ! -f ./target-info.json ]; then
    echo "Error: target-info.json not found. Run steps 1-5 first."
    exit 1
fi

TARGET_CHAIN_ID=$(jq -r '.chainId' ./target-info.json)
TARGET_SUBNET_ID=$(jq -r '.subnetId' ./target-info.json)

echo "Target Chain ID:  $TARGET_CHAIN_ID"
echo "Target Subnet ID: $TARGET_SUBNET_ID"
echo ""

# Get bootstrap info from the L1 validator (port 9300)
L1_VALIDATOR_URI="http://127.0.0.1:9300"
echo "Getting bootstrap info from L1 validator at $L1_VALIDATOR_URI..."

L1_NODE_ID=$(curl -s -X POST -H "Content-Type: application/json" \
    --data '{"jsonrpc":"2.0","method":"info.getNodeID","id":1}' \
    "$L1_VALIDATOR_URI/ext/info" | jq -r '.result.nodeID')

if [ -z "$L1_NODE_ID" ] || [ "$L1_NODE_ID" = "null" ]; then
    echo "Error: Could not get L1 validator node ID. Is the target network running?"
    exit 1
fi

echo "L1 Validator Node ID: $L1_NODE_ID"

# Create RPC node directory
RPC_NODE_DIR="./target_network/rpc-node"
rm -rf "$RPC_NODE_DIR"
mkdir -p "$RPC_NODE_DIR/db"
mkdir -p "$RPC_NODE_DIR/logs"
mkdir -p "$RPC_NODE_DIR/chainData"

# Write chain config for RPC node (pruning disabled, state-sync disabled)
CHAIN_CONFIG_DIR="$RPC_NODE_DIR/configs/chains/$TARGET_CHAIN_ID"
mkdir -p "$CHAIN_CONFIG_DIR"
cat > "$CHAIN_CONFIG_DIR/config.json" << 'EOF'
{
  "pruning-enabled": false,
  "state-sync-enabled": false
}
EOF

echo "Chain config written to $CHAIN_CONFIG_DIR/config.json"

# Start RPC node with ephemeral staking keys (random credentials)
RPC_HTTP_PORT=9400
RPC_STAKING_PORT=9401

echo ""
echo "Starting RPC node on port $RPC_HTTP_PORT..."
echo "  - Ephemeral staking keys (random credentials)"
echo "  - State sync disabled"
echo "  - Pruning disabled"
echo ""

./bin/avalanchego \
    --http-port=$RPC_HTTP_PORT \
    --staking-port=$RPC_STAKING_PORT \
    --db-dir=$RPC_NODE_DIR/db \
    --log-dir=$RPC_NODE_DIR/logs \
    --chain-data-dir=$RPC_NODE_DIR/chainData \
    --data-dir=$RPC_NODE_DIR \
    --network-id=local \
    --http-host=127.0.0.1 \
    --sybil-protection-enabled=false \
    --plugin-dir=./bin/plugins \
    --config-file=./node-config.json \
    --staking-ephemeral-cert-enabled=true \
    --staking-ephemeral-signer-enabled=true \
    --track-subnets=$TARGET_SUBNET_ID \
    --bootstrap-ips=127.0.0.1:9301 \
    --bootstrap-ids=$L1_NODE_ID \
    &> "$RPC_NODE_DIR/logs/process.log" &

RPC_PID=$!
echo "RPC node started (PID: $RPC_PID)"

# Save RPC PID
echo "$RPC_PID" >> ./target-pids.txt

# Wait for RPC node to be healthy
echo "Waiting for RPC node to become healthy..."
for i in {1..60}; do
    if curl -s -X POST -H "Content-Type: application/json" \
        --data '{"jsonrpc":"2.0","method":"info.getNodeID","id":1}' \
        "http://127.0.0.1:$RPC_HTTP_PORT/ext/info" | jq -e '.result.nodeID' > /dev/null 2>&1; then
        echo "RPC node is healthy!"
        break
    fi
    if [ $i -eq 60 ]; then
        echo "Error: RPC node failed to start"
        cat "$RPC_NODE_DIR/logs/process.log"
        exit 1
    fi
    sleep 1
done

RPC_NODE_ID=$(curl -s -X POST -H "Content-Type: application/json" \
    --data '{"jsonrpc":"2.0","method":"info.getNodeID","id":1}' \
    "http://127.0.0.1:$RPC_HTTP_PORT/ext/info" | jq -r '.result.nodeID')

echo "RPC Node ID: $RPC_NODE_ID"

# Wait for chain to sync
RPC_URL="http://127.0.0.1:$RPC_HTTP_PORT/ext/bc/$TARGET_CHAIN_ID/rpc"
echo ""
echo "Waiting for chain to sync..."
echo "RPC URL: $RPC_URL"

for i in {1..120}; do
    # Try to get block number - if it works, chain is synced
    BLOCK=$(curl -s -X POST -H "Content-Type: application/json" \
        --data '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}' \
        "$RPC_URL" 2>/dev/null | jq -r '.result' 2>/dev/null)

    if [ -n "$BLOCK" ] && [ "$BLOCK" != "null" ]; then
        BLOCK_DEC=$((BLOCK))
        echo "Chain synced! Current block: $BLOCK_DEC"
        break
    fi

    if [ $i -eq 120 ]; then
        echo "Error: Chain failed to sync within 120 seconds"
        echo "Check logs at: $RPC_NODE_DIR/logs/"
        exit 1
    fi

    if [ $((i % 10)) -eq 0 ]; then
        echo "  Still waiting... ($i seconds)"
    fi
    sleep 1
done

# Verify state by checking balance
TARGET_ADDRESS=$(cat ./target-address.txt)
echo ""
echo "Verifying state on RPC node..."

BALANCE=$(go run ./cmd/balance "$RPC_URL" "$TARGET_ADDRESS")
echo "Balance of $TARGET_ADDRESS: $BALANCE wei"

if [ "$BALANCE" = "0" ]; then
    echo "Warning: Balance is 0 - state may not have synced correctly"
else
    echo "State verified successfully!"
fi

# Update target-info.json with RPC node URL for step 7
jq --arg rpc "$RPC_URL" '.rpcUrl = $rpc' ./target-info.json > ./target-info-new.json
mv ./target-info-new.json ./target-info.json

echo ""
echo "=========================================="
echo "RPC Node Bootstrap Complete!"
echo ""
echo "RPC Node ID: $RPC_NODE_ID"
echo "RPC URL:     $RPC_URL"
echo ""
echo "target-info.json updated with RPC node URL"
echo "Step 7 will now use this RPC node."
echo "=========================================="
echo ""
echo "Run ./7_post_transplant_tx.sh to send transactions via RPC node"
