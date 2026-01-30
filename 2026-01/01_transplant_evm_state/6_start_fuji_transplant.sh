#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=========================================="
echo "=== Step 6: Start Fuji Node with Transplanted State ==="
echo "=========================================="
echo ""

# Verify prerequisites
if [ ! -f ./fuji-info.json ]; then
    echo "Error: fuji-info.json not found. Run steps 4-5 first."
    exit 1
fi

if [ ! -f ./source-chain-id.txt ]; then
    echo "Error: source-chain-id.txt not found. Run steps 1-3 first."
    exit 1
fi

# Load configuration
SOURCE_CHAIN_ID=$(cat ./source-chain-id.txt)
FUJI_SUBNET_ID=$(jq -r '.subnetId' ./fuji-info.json)
FUJI_CHAIN_ID=$(jq -r '.chainId' ./fuji-info.json)
NODE_ID=$(jq -r '.nodeId' ./fuji-info.json)

echo "Source Chain ID (local):  $SOURCE_CHAIN_ID"
echo "Target Subnet ID (Fuji):  $FUJI_SUBNET_ID"
echo "Target Chain ID (Fuji):   $FUJI_CHAIN_ID"
echo "Node ID:                  $NODE_ID"
echo ""

# Find source chain data
SOURCE_CHAIN_DATA=""
for dir in ./source_network/l1-validator-*/chainData/$SOURCE_CHAIN_ID; do
    if [ -d "$dir" ]; then
        SOURCE_CHAIN_DATA="$dir"
        break
    fi
done

if [ -z "$SOURCE_CHAIN_DATA" ] || [ ! -d "$SOURCE_CHAIN_DATA" ]; then
    echo "Error: Could not find source chain data"
    exit 1
fi

echo "Source chain data: $SOURCE_CHAIN_DATA"
echo ""

# Prepare Fuji node directory
FUJI_NODE_DIR="./fuji_node"
STAKING_DIR="$FUJI_NODE_DIR/staking"

if [ ! -f "$STAKING_DIR/staker.crt" ]; then
    echo "Error: Staking keys not found. Run 4_prepare_fuji_node.sh first."
    exit 1
fi

# Inside container, avalanchego uses /root/.avalanchego/ as default
# chainData goes to /root/.avalanchego/chainData/
# We mount fuji_node to /root/.avalanchego/

# Create chain data directory structure for Fuji chain
TARGET_CHAIN_DATA="$FUJI_NODE_DIR/chainData/$FUJI_CHAIN_ID"
mkdir -p "$TARGET_CHAIN_DATA"

# Transplant the state
echo "Transplanting state..."
echo "  From: $SOURCE_CHAIN_DATA/db/"
echo "  To:   $TARGET_CHAIN_DATA/db/"
echo ""

sudo rm -rf "$TARGET_CHAIN_DATA/db"
sudo cp -r "$SOURCE_CHAIN_DATA/db" "$TARGET_CHAIN_DATA/db"

echo "State transplanted!"
echo ""

# Write chain config
CHAIN_CONFIG_DIR="$FUJI_NODE_DIR/configs/chains/$FUJI_CHAIN_ID"
mkdir -p "$CHAIN_CONFIG_DIR"
cat > "$CHAIN_CONFIG_DIR/config.json" << 'EOF'
{
  "pruning-enabled": false,
  "state-sync-enabled": false
}
EOF

echo "Chain config written to $CHAIN_CONFIG_DIR/config.json"

# Stop any existing container (don't remove db)
CONTAINER_NAME="fuji_validator"
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "Stopping existing container $CONTAINER_NAME..."
    docker stop "$CONTAINER_NAME" 2>/dev/null || true
    docker rm "$CONTAINER_NAME" 2>/dev/null || true
fi

# Create logs directory
mkdir -p "$FUJI_NODE_DIR/logs"

HTTP_PORT=9750
STAKING_PORT=9751

echo ""
echo "Starting Fuji node container..."
echo "  Container:    $CONTAINER_NAME"
echo "  HTTP Port:    $HTTP_PORT"
echo "  Staking Port: $STAKING_PORT"
echo "  Network:      Fuji (network-id=5)"
echo ""

docker run -d \
    --name "$CONTAINER_NAME" \
    --net=host \
    -v "$(pwd)/fuji_node:/root/.avalanchego/" \
    -v "$(pwd)/bin/plugins:/plugins" \
    avaplatform/avalanchego:v1.14.1 \
    ./avalanchego \
    --network-id=fuji \
    --http-port=$HTTP_PORT \
    --staking-port=$STAKING_PORT \
    --db-type=pebbledb \
    --http-host=0.0.0.0 \
    --http-allowed-hosts="*" \
    --plugin-dir=/plugins \
    --staking-tls-cert-file=/root/.avalanchego/staking/staker.crt \
    --staking-tls-key-file=/root/.avalanchego/staking/staker.key \
    --staking-signer-key-file=/root/.avalanchego/staking/signer.key \
    --track-subnets=$FUJI_SUBNET_ID \
    --index-enabled=true \
    --partial-sync-primary-network=true

echo "Container started: $CONTAINER_NAME"

# Wait for node to become healthy
echo ""
echo "Waiting for node to become healthy..."
for i in {1..120}; do
    HEALTH=$(curl -s -X POST -H "Content-Type: application/json" \
        --data '{"jsonrpc":"2.0","method":"health.health","id":1}' \
        "http://127.0.0.1:$HTTP_PORT/ext/health" 2>/dev/null | jq -r '.result.healthy' 2>/dev/null)

    if [ "$HEALTH" = "true" ]; then
        echo "Node is healthy!"
        break
    fi

    if [ $i -eq 120 ]; then
        echo "Warning: Node not healthy after 120 seconds"
        echo "This is normal during initial Fuji sync."
        echo "Check logs with: docker logs $CONTAINER_NAME"
    fi

    if [ $((i % 10)) -eq 0 ]; then
        echo "  Still waiting... ($i seconds)"
    fi
    sleep 1
done

# Get actual node ID to verify
ACTUAL_NODE_ID=$(curl -s -X POST -H "Content-Type: application/json" \
    --data '{"jsonrpc":"2.0","method":"info.getNodeID","id":1}' \
    "http://127.0.0.1:$HTTP_PORT/ext/info" 2>/dev/null | jq -r '.result.nodeID' 2>/dev/null)

echo ""
echo "Actual Node ID: $ACTUAL_NODE_ID"

if [ "$ACTUAL_NODE_ID" != "$NODE_ID" ]; then
    echo "WARNING: Node ID mismatch!"
    echo "  Expected: $NODE_ID"
    echo "  Actual:   $ACTUAL_NODE_ID"
    echo "This may cause validation issues."
fi

# Construct RPC URL
RPC_URL="http://127.0.0.1:$HTTP_PORT/ext/bc/$FUJI_CHAIN_ID/rpc"

# Update fuji-info.json with RPC URL
jq --arg rpc "$RPC_URL" '.rpcUrl = $rpc' ./fuji-info.json > ./fuji-info-new.json
mv ./fuji-info-new.json ./fuji-info.json

echo ""
echo "=========================================="
echo "Fuji Node Running with Transplanted State!"
echo "=========================================="
echo ""
echo "Node ID:   $ACTUAL_NODE_ID"
echo "RPC URL:   $RPC_URL"
echo "Container: $CONTAINER_NAME"
echo ""
echo "View logs:  docker logs -f $CONTAINER_NAME"
echo "Stop node:  docker stop $CONTAINER_NAME"
echo ""
echo "NOTE: The node needs to sync with Fuji primary network first."
echo ""
echo "Check bootstrap progress with:"
echo "  curl -X POST -H 'Content-Type: application/json' \\"
echo "    --data '{\"jsonrpc\":\"2.0\",\"method\":\"info.isBootstrapped\",\"params\":{\"chain\":\"P\"},\"id\":1}' \\"
echo "    http://127.0.0.1:$HTTP_PORT/ext/info"
echo ""
echo "Once bootstrapped, run ./8_verify.sh to verify the transplanted state."
echo "=========================================="
