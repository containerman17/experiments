#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Step 4: Transplanting State to New Network ==="

# Verify source data exists
if [ ! -f ./source-chain-id.txt ]; then
    echo "Error: source-chain-id.txt not found. Run steps 1-3 first."
    exit 1
fi

SOURCE_CHAIN_ID=$(cat ./source-chain-id.txt)
echo "Source chain ID: $SOURCE_CHAIN_ID"

# Find source chain data directory
SOURCE_CHAIN_DATA=""
for dir in ./source_network/l1-validator-*/chainData/$SOURCE_CHAIN_ID; do
    if [ -d "$dir" ]; then
        SOURCE_CHAIN_DATA="$dir"
        break
    fi
done

if [ -z "$SOURCE_CHAIN_DATA" ] || [ ! -d "$SOURCE_CHAIN_DATA" ]; then
    echo "Error: Could not find source chain data directory"
    echo "Looking for: ./source_network/l1-validator-*/chainData/$SOURCE_CHAIN_ID"
    ls -la ./source_network/ 2>/dev/null || true
    exit 1
fi

echo "Source chain data: $SOURCE_CHAIN_DATA"
echo "Contents:"
ls -la "$SOURCE_CHAIN_DATA/"

# Start the target network (creates NEW chain with DIFFERENT chain ID)
echo ""
echo "Starting target network..."
go run ./cmd/network start \
    --data-dir ./target_network \
    --output ./target-info.json \
    --validators 1 \
    --chain-name target \
    --background

TARGET_CHAIN_ID=$(jq -r '.chainId' ./target-info.json)
echo "Target chain ID: $TARGET_CHAIN_ID"

# Stop target network to copy state
echo ""
echo "Stopping target network to transplant state..."
go run ./cmd/network stop --info ./target-info.json
sleep 2

# Find target chain data directory
TARGET_CHAIN_DATA=""
for dir in ./target_network/l1-validator-*/chainData/$TARGET_CHAIN_ID; do
    if [ -d "$dir" ]; then
        TARGET_CHAIN_DATA="$dir"
        break
    fi
done

if [ -z "$TARGET_CHAIN_DATA" ]; then
    echo "Error: Could not find target chain data directory"
    exit 1
fi

echo "Target chain data: $TARGET_CHAIN_DATA"

# Transplant the state!
echo ""
echo "Transplanting state..."
echo "  From: $SOURCE_CHAIN_DATA/db/"
echo "  To:   $TARGET_CHAIN_DATA/db/"

rm -rf "$TARGET_CHAIN_DATA/db"
cp -r "$SOURCE_CHAIN_DATA/db" "$TARGET_CHAIN_DATA/db"

echo "State transplanted!"

# Get target node directory for restart
TARGET_NODE_DIR=$(dirname $(dirname "$TARGET_CHAIN_DATA"))
echo "Target node dir: $TARGET_NODE_DIR"

# Kill any lingering processes
pkill -f avalanchego 2>/dev/null || true
sleep 1

# Restart primary nodes
echo ""
echo "Starting primary network nodes..."

./bin/avalanchego \
    --http-port=9100 \
    --staking-port=9101 \
    --db-dir=./target_network/node-0/db \
    --log-dir=./target_network/node-0/logs \
    --chain-data-dir=./target_network/node-0/chainData \
    --data-dir=./target_network/node-0 \
    --network-id=local \
    --http-host=127.0.0.1 \
    --sybil-protection-enabled=false \
    --plugin-dir=./bin/plugins \
    --config-file=./node-config.json \
    --staking-tls-cert-file=./target_network/staking/local/staker1.crt \
    --staking-tls-key-file=./target_network/staking/local/staker1.key \
    --staking-signer-key-file=./target_network/staking/local/signer1.key \
    --bootstrap-ips= \
    --bootstrap-ids= \
    &> ./target_network/node-0/logs/restart.log &

NODE0_PID=$!
echo "Primary node 0 started (PID: $NODE0_PID)"
sleep 10

# Get node 0 ID
NODE0_ID=$(curl -s -X POST -H "Content-Type: application/json" \
    --data '{"jsonrpc":"2.0","method":"info.getNodeID","id":1}' \
    http://127.0.0.1:9100/ext/info | jq -r '.result.nodeID')
echo "Node 0 ID: $NODE0_ID"

./bin/avalanchego \
    --http-port=9200 \
    --staking-port=9201 \
    --db-dir=./target_network/node-1/db \
    --log-dir=./target_network/node-1/logs \
    --chain-data-dir=./target_network/node-1/chainData \
    --data-dir=./target_network/node-1 \
    --network-id=local \
    --http-host=127.0.0.1 \
    --sybil-protection-enabled=false \
    --plugin-dir=./bin/plugins \
    --config-file=./node-config.json \
    --staking-tls-cert-file=./target_network/staking/local/staker2.crt \
    --staking-tls-key-file=./target_network/staking/local/staker2.key \
    --staking-signer-key-file=./target_network/staking/local/signer2.key \
    --bootstrap-ips=127.0.0.1:9101 \
    --bootstrap-ids=$NODE0_ID \
    &> ./target_network/node-1/logs/restart.log &

NODE1_PID=$!
echo "Primary node 1 started (PID: $NODE1_PID)"
sleep 5

# Start L1 validator with transplanted state
echo "Starting L1 validator with transplanted state..."
TARGET_SUBNET_ID=$(jq -r '.subnetId' ./target-info.json)

./bin/avalanchego \
    --http-port=9300 \
    --staking-port=9301 \
    --db-dir=./target_network/l1-validator-2/db \
    --log-dir=./target_network/l1-validator-2/logs \
    --chain-data-dir=./target_network/l1-validator-2/chainData \
    --data-dir=./target_network/l1-validator-2 \
    --network-id=local \
    --http-host=127.0.0.1 \
    --sybil-protection-enabled=false \
    --plugin-dir=./bin/plugins \
    --config-file=./node-config.json \
    --staking-ephemeral-cert-enabled=true \
    --staking-ephemeral-signer-enabled=true \
    --track-subnets=$TARGET_SUBNET_ID \
    --bootstrap-ips=127.0.0.1:9101 \
    --bootstrap-ids=$NODE0_ID \
    &> ./target_network/l1-validator-2/logs/restart.log &

L1_PID=$!
echo "L1 validator started (PID: $L1_PID)"

# Save PIDs
echo "$NODE0_PID $NODE1_PID $L1_PID" > ./target-pids.txt

echo "Waiting for L1 chain to start..."
sleep 15

# Update target info with RPC URL
RPC_URL="http://127.0.0.1:9300/ext/bc/$TARGET_CHAIN_ID/rpc"
jq --arg rpc "$RPC_URL" '.rpcUrl = $rpc' ./target-info.json > ./target-info-new.json
mv ./target-info-new.json ./target-info.json

echo ""
echo "=========================================="
echo "Target network running with transplanted state!"
echo "Target Chain ID: $TARGET_CHAIN_ID"
echo "RPC URL: $RPC_URL"
echo "=========================================="
echo ""
echo "Run ./5_verify.sh to verify the transplanted state"
