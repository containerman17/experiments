#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Step 1: Starting Source Network (Local DevNet) ==="

# Container names
CONTAINER_NODE0="source_node0"
CONTAINER_NODE1="source_node1"
CONTAINER_L1="source_l1_validator"

# Ports
NODE0_HTTP_PORT=9100
NODE0_STAKING_PORT=9101
NODE1_HTTP_PORT=9200
NODE1_STAKING_PORT=9201
L1_HTTP_PORT=9300
L1_STAKING_PORT=9301

# Clean up any existing containers
echo "Cleaning up existing containers..."
for container in "$CONTAINER_NODE0" "$CONTAINER_NODE1" "$CONTAINER_L1"; do
    docker stop "$container" 2>/dev/null || true
    docker rm "$container" 2>/dev/null || true
done

# Clean up old network data
sudo rm -rf ./source_network
mkdir -p ./source_network

# Create directories for each node
mkdir -p ./source_network/node-0/{db,logs,configs}
mkdir -p ./source_network/node-1/{db,logs,configs}
mkdir -p ./source_network/l1-validator-2/{db,logs,configs,chainData}

# Copy staking keys for primary nodes
mkdir -p ./source_network/node-0/staking
mkdir -p ./source_network/node-1/staking
cp ./staking/local/staker1.crt ./source_network/node-0/staking/staker.crt
cp ./staking/local/staker1.key ./source_network/node-0/staking/staker.key
cp ./staking/local/signer1.key ./source_network/node-0/staking/signer.key
cp ./staking/local/staker2.crt ./source_network/node-1/staking/staker.crt
cp ./staking/local/staker2.key ./source_network/node-1/staking/staker.key
cp ./staking/local/signer2.key ./source_network/node-1/staking/signer.key

# Write node config
cat > ./source_network/node-config.json << 'EOF'
{
  "log-level": "info",
  "log-display-level": "off"
}
EOF

echo "Starting primary network nodes..."

# Start Node 0 (bootstrap node)
echo "Starting $CONTAINER_NODE0..."
docker run -d \
    --name "$CONTAINER_NODE0" \
    --net=host \
    -v "$(pwd)/source_network/node-0:/root/.avalanchego" \
    -v "$(pwd)/bin/plugins:/plugins" \
    -v "$(pwd)/source_network/node-config.json:/config.json:ro" \
    avaplatform/avalanchego:v1.14.1 \
    ./avalanchego \
    --http-port=$NODE0_HTTP_PORT \
    --staking-port=$NODE0_STAKING_PORT \
    --db-dir=/root/.avalanchego/db \
    --log-dir=/root/.avalanchego/logs \
    --network-id=local \
    --http-host=0.0.0.0 \
    --http-allowed-hosts="*" \
    --sybil-protection-enabled=false \
    --plugin-dir=/plugins \
    --config-file=/config.json \
    --staking-tls-cert-file=/root/.avalanchego/staking/staker.crt \
    --staking-tls-key-file=/root/.avalanchego/staking/staker.key \
    --staking-signer-key-file=/root/.avalanchego/staking/signer.key \
    --bootstrap-ips= \
    --bootstrap-ids=

# Wait for node 0 to be healthy
echo "Waiting for $CONTAINER_NODE0 to become healthy..."
NODE0_URI="http://127.0.0.1:$NODE0_HTTP_PORT"
for i in {1..60}; do
    NODE0_ID=$(curl -s -X POST -H "Content-Type: application/json" \
        --data '{"jsonrpc":"2.0","method":"info.getNodeID","id":1}' \
        "$NODE0_URI/ext/info" 2>/dev/null | jq -r '.result.nodeID' 2>/dev/null)
    if [ -n "$NODE0_ID" ] && [ "$NODE0_ID" != "null" ]; then
        echo "  Node 0 ready: $NODE0_ID"
        break
    fi
    if [ $i -eq 60 ]; then
        echo "Error: Node 0 failed to start"
        docker logs "$CONTAINER_NODE0" | tail -20
        exit 1
    fi
    sleep 1
done

# Start Node 1 (connects to Node 0)
echo "Starting $CONTAINER_NODE1..."
docker run -d \
    --name "$CONTAINER_NODE1" \
    --net=host \
    -v "$(pwd)/source_network/node-1:/root/.avalanchego" \
    -v "$(pwd)/bin/plugins:/plugins" \
    -v "$(pwd)/source_network/node-config.json:/config.json:ro" \
    avaplatform/avalanchego:v1.14.1 \
    ./avalanchego \
    --http-port=$NODE1_HTTP_PORT \
    --staking-port=$NODE1_STAKING_PORT \
    --db-dir=/root/.avalanchego/db \
    --log-dir=/root/.avalanchego/logs \
    --network-id=local \
    --http-host=0.0.0.0 \
    --http-allowed-hosts="*" \
    --sybil-protection-enabled=false \
    --plugin-dir=/plugins \
    --config-file=/config.json \
    --staking-tls-cert-file=/root/.avalanchego/staking/staker.crt \
    --staking-tls-key-file=/root/.avalanchego/staking/staker.key \
    --staking-signer-key-file=/root/.avalanchego/staking/signer.key \
    --bootstrap-ips=127.0.0.1:$NODE0_STAKING_PORT \
    --bootstrap-ids=$NODE0_ID

# Wait for node 1 to be healthy
echo "Waiting for $CONTAINER_NODE1 to become healthy..."
NODE1_URI="http://127.0.0.1:$NODE1_HTTP_PORT"
for i in {1..60}; do
    NODE1_ID=$(curl -s -X POST -H "Content-Type: application/json" \
        --data '{"jsonrpc":"2.0","method":"info.getNodeID","id":1}' \
        "$NODE1_URI/ext/info" 2>/dev/null | jq -r '.result.nodeID' 2>/dev/null)
    if [ -n "$NODE1_ID" ] && [ "$NODE1_ID" != "null" ]; then
        echo "  Node 1 ready: $NODE1_ID"
        break
    fi
    if [ $i -eq 60 ]; then
        echo "Error: Node 1 failed to start"
        docker logs "$CONTAINER_NODE1" | tail -20
        exit 1
    fi
    sleep 1
done

echo ""
echo "Creating subnet and chain..."

# Create subnet and chain using Go wallet tool
RESULT=$(go run ./cmd/network create-chain --node-uri "$NODE0_URI" --genesis ./genesis.json --chain-config ./chain-config.json)
SUBNET_ID=$(echo "$RESULT" | jq -r '.subnetId')
CHAIN_ID=$(echo "$RESULT" | jq -r '.chainId')

if [ -z "$SUBNET_ID" ] || [ "$SUBNET_ID" = "null" ]; then
    echo "Error: Failed to create subnet/chain"
    echo "$RESULT"
    exit 1
fi

echo "  Subnet: $SUBNET_ID"
echo "  Chain:  $CHAIN_ID"

# Write chain config to all nodes
for nodeDir in ./source_network/node-0 ./source_network/node-1 ./source_network/l1-validator-2; do
    mkdir -p "$nodeDir/configs/chains/$CHAIN_ID"
    cp ./chain-config.json "$nodeDir/configs/chains/$CHAIN_ID/config.json"
done

# Start L1 Validator (with ephemeral keys, tracks the subnet)
echo ""
echo "Starting L1 validator..."
docker run -d \
    --name "$CONTAINER_L1" \
    --net=host \
    -v "$(pwd)/source_network/l1-validator-2:/root/.avalanchego" \
    -v "$(pwd)/bin/plugins:/plugins" \
    -v "$(pwd)/source_network/node-config.json:/config.json:ro" \
    avaplatform/avalanchego:v1.14.1 \
    ./avalanchego \
    --http-port=$L1_HTTP_PORT \
    --staking-port=$L1_STAKING_PORT \
    --db-dir=/root/.avalanchego/db \
    --log-dir=/root/.avalanchego/logs \
    --chain-data-dir=/root/.avalanchego/chainData \
    --network-id=local \
    --http-host=0.0.0.0 \
    --http-allowed-hosts="*" \
    --sybil-protection-enabled=false \
    --plugin-dir=/plugins \
    --config-file=/config.json \
    --staking-ephemeral-cert-enabled=true \
    --staking-ephemeral-signer-enabled=true \
    --track-subnets=$SUBNET_ID \
    --bootstrap-ips=127.0.0.1:$NODE0_STAKING_PORT \
    --bootstrap-ids=$NODE0_ID

# Wait for L1 validator to be healthy
echo "Waiting for $CONTAINER_L1 to become healthy..."
L1_URI="http://127.0.0.1:$L1_HTTP_PORT"
for i in {1..60}; do
    L1_NODE_ID=$(curl -s -X POST -H "Content-Type: application/json" \
        --data '{"jsonrpc":"2.0","method":"info.getNodeID","id":1}' \
        "$L1_URI/ext/info" 2>/dev/null | jq -r '.result.nodeID' 2>/dev/null)
    if [ -n "$L1_NODE_ID" ] && [ "$L1_NODE_ID" != "null" ]; then
        echo "  L1 Validator ready: $L1_NODE_ID"
        break
    fi
    if [ $i -eq 60 ]; then
        echo "Error: L1 validator failed to start"
        docker logs "$CONTAINER_L1" | tail -20
        exit 1
    fi
    sleep 1
done

# Convert subnet to L1
echo ""
echo "Converting subnet to L1..."
go run ./cmd/network convert-to-l1 \
    --node-uri "$NODE0_URI" \
    --l1-node-uri "$L1_URI" \
    --subnet-id "$SUBNET_ID" \
    --chain-id "$CHAIN_ID"

sleep 3

# Construct RPC URL
RPC_URL="$L1_URI/ext/bc/$CHAIN_ID/rpc"

# Save network info
cat > ./source-info.json << EOF
{
  "dataDir": "$(pwd)/source_network",
  "chainId": "$CHAIN_ID",
  "subnetId": "$SUBNET_ID",
  "rpcUrl": "$RPC_URL",
  "containers": ["$CONTAINER_NODE0", "$CONTAINER_NODE1", "$CONTAINER_L1"]
}
EOF

echo ""
echo "=========================================="
echo "Source network started!"
echo ""
echo "Chain ID:  $CHAIN_ID"
echo "Subnet ID: $SUBNET_ID"
echo "RPC URL:   $RPC_URL"
echo ""
echo "Containers:"
echo "  - $CONTAINER_NODE0 (primary node 0)"
echo "  - $CONTAINER_NODE1 (primary node 1)"
echo "  - $CONTAINER_L1 (L1 validator)"
echo ""
echo "View logs:  docker logs -f $CONTAINER_L1"
echo "=========================================="
echo ""
echo "Run ./2_populate_state.sh to add test data"
