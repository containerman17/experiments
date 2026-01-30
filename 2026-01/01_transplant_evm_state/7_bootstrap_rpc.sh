#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=========================================="
echo "=== Step 7: Bootstrap Fuji RPC Node ==="
echo "=========================================="
echo ""
echo "This starts a fresh RPC node with ephemeral credentials"
echo "that syncs from the Fuji network independently."
echo ""

if [ ! -f ./fuji-info.json ]; then
    echo "Error: fuji-info.json not found. Run steps 1-6 first."
    exit 1
fi

FUJI_CHAIN_ID=$(jq -r '.chainId' ./fuji-info.json)
FUJI_SUBNET_ID=$(jq -r '.subnetId' ./fuji-info.json)
VALIDATOR_NODE_ID=$(jq -r '.nodeId' ./fuji-info.json)

echo "Target Chain ID:  $FUJI_CHAIN_ID"
echo "Target Subnet ID: $FUJI_SUBNET_ID"
echo "Validator Node:   $VALIDATOR_NODE_ID"
echo ""

# Check if validator is running
VALIDATOR_URI="http://127.0.0.1:9750"
VALIDATOR_HEALTH=$(curl -s -X POST -H "Content-Type: application/json" \
    --data '{"jsonrpc":"2.0","method":"info.getNodeID","id":1}' \
    "$VALIDATOR_URI/ext/info" 2>/dev/null | jq -r '.result.nodeID' 2>/dev/null)

if [ -z "$VALIDATOR_HEALTH" ] || [ "$VALIDATOR_HEALTH" = "null" ]; then
    echo "Error: Validator node not running at $VALIDATOR_URI"
    echo "Run 6_start_fuji_transplant.sh first."
    exit 1
fi

echo "Validator is running: $VALIDATOR_HEALTH"
echo ""

# Stop any existing RPC container (don't remove db)
CONTAINER_NAME="fuji_rpc"
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "Stopping existing container $CONTAINER_NAME..."
    docker stop "$CONTAINER_NAME" 2>/dev/null || true
    docker rm "$CONTAINER_NAME" 2>/dev/null || true
fi

# Create RPC node directory
RPC_NODE_DIR="./fuji_rpc_node"
mkdir -p "$RPC_NODE_DIR/db"
mkdir -p "$RPC_NODE_DIR/logs"
mkdir -p "$RPC_NODE_DIR/chainData"
mkdir -p "$RPC_NODE_DIR/configs/chains/$FUJI_CHAIN_ID"

# Write chain config for RPC node
cat > "$RPC_NODE_DIR/configs/chains/$FUJI_CHAIN_ID/config.json" << 'EOF'
{
  "pruning-enabled": false,
  "state-sync-enabled": false
}
EOF

echo "Chain config written"

RPC_HTTP_PORT=9660
RPC_STAKING_PORT=9661

echo ""
echo "Starting RPC node container..."
echo "  Container:    $CONTAINER_NAME"
echo "  HTTP Port:    $RPC_HTTP_PORT"
echo "  Staking Port: $RPC_STAKING_PORT"
echo "  - Ephemeral staking keys (random identity)"
echo ""

docker run -d \
    --name "$CONTAINER_NAME" \
    --net=host \
    -v "$(pwd)/fuji_rpc_node:/root/.avalanchego/" \
    -v "$(pwd)/bin/plugins:/plugins" \
    avaplatform/avalanchego:v1.14.1 \
    ./avalanchego \
    --network-id=fuji \
    --http-port=$RPC_HTTP_PORT \
    --staking-port=$RPC_STAKING_PORT \
    --db-type=pebbledb \
    --http-host=0.0.0.0 \
    --http-allowed-hosts="*" \
    --plugin-dir=/plugins \
    --index-enabled=true \
    --staking-ephemeral-cert-enabled=true \
    --staking-ephemeral-signer-enabled=true \
    --track-subnets=$FUJI_SUBNET_ID \
    --partial-sync-primary-network=true

echo "Container started: $CONTAINER_NAME"

# Wait for RPC node to be healthy
echo ""
echo "Waiting for RPC node to become healthy..."
for i in {1..120}; do
    RPC_NODE_ID=$(curl -s -X POST -H "Content-Type: application/json" \
        --data '{"jsonrpc":"2.0","method":"info.getNodeID","id":1}' \
        "http://127.0.0.1:$RPC_HTTP_PORT/ext/info" 2>/dev/null | jq -r '.result.nodeID' 2>/dev/null)

    if [ -n "$RPC_NODE_ID" ] && [ "$RPC_NODE_ID" != "null" ]; then
        echo "RPC node is healthy!"
        echo "RPC Node ID: $RPC_NODE_ID"
        break
    fi

    if [ $i -eq 120 ]; then
        echo "Error: RPC node failed to start"
        docker logs "$CONTAINER_NAME" | tail -50
        exit 1
    fi

    if [ $((i % 10)) -eq 0 ]; then
        echo "  Still waiting... ($i seconds)"
    fi
    sleep 1
done

# Wait for P-Chain bootstrap
echo ""
echo "Waiting for P-Chain bootstrap..."
for i in {1..300}; do
    IS_BOOTSTRAPPED=$(curl -s -X POST -H "Content-Type: application/json" \
        --data '{"jsonrpc":"2.0","method":"info.isBootstrapped","params":{"chain":"P"},"id":1}' \
        "http://127.0.0.1:$RPC_HTTP_PORT/ext/info" 2>/dev/null | jq -r '.result.isBootstrapped' 2>/dev/null)

    if [ "$IS_BOOTSTRAPPED" = "true" ]; then
        echo "P-Chain bootstrapped!"
        break
    fi

    if [ $i -eq 300 ]; then
        echo "Warning: P-Chain not bootstrapped after 5 minutes"
        echo "The RPC node may still be syncing."
        echo "Check logs with: docker logs $CONTAINER_NAME"
    fi

    if [ $((i % 30)) -eq 0 ]; then
        echo "  Still bootstrapping P-Chain... ($i seconds)"
    fi
    sleep 1
done

# Wait for L1 chain to sync
RPC_URL="http://127.0.0.1:$RPC_HTTP_PORT/ext/bc/$FUJI_CHAIN_ID/rpc"
VALIDATOR_RPC_URL="http://127.0.0.1:9750/ext/bc/$FUJI_CHAIN_ID/rpc"

echo ""
echo "Waiting for L1 chain to sync..."
echo "RPC URL: $RPC_URL"

# Get expected block count from validator
EXPECTED_BLOCK=$(curl -s -X POST -H "Content-Type: application/json" \
    --data '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}' \
    "$VALIDATOR_RPC_URL" 2>/dev/null | jq -r '.result' 2>/dev/null)

if [ -z "$EXPECTED_BLOCK" ] || [ "$EXPECTED_BLOCK" = "null" ]; then
    echo "Warning: Could not get block number from validator"
    echo "The L1 chain may not be ready yet."
else
    EXPECTED_BLOCK_DEC=$((EXPECTED_BLOCK))
    echo "Validator is at block: $EXPECTED_BLOCK_DEC"

    for i in {1..180}; do
        BLOCK=$(curl -s -X POST -H "Content-Type: application/json" \
            --data '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}' \
            "$RPC_URL" 2>/dev/null | jq -r '.result' 2>/dev/null)

        if [ -n "$BLOCK" ] && [ "$BLOCK" != "null" ]; then
            BLOCK_DEC=$((BLOCK))
            if [ "$BLOCK_DEC" -ge "$EXPECTED_BLOCK_DEC" ]; then
                echo "Chain synced! Block: $BLOCK_DEC"
                break
            else
                if [ $((i % 10)) -eq 0 ]; then
                    echo "  Syncing... block $BLOCK_DEC / $EXPECTED_BLOCK_DEC"
                fi
            fi
        fi

        if [ $i -eq 180 ]; then
            echo "Warning: Chain not fully synced after 3 minutes"
            echo "Continuing anyway - chain may still be syncing."
        fi

        sleep 1
    done
fi

# Verify state by checking balance
TARGET_ADDRESS=$(cat ./target-address.txt)
EXPECTED_BALANCE=$(cat ./expected-native-balance.txt)

echo ""
echo "Verifying state on RPC node..."

BALANCE=$(go run ./cmd/balance "$RPC_URL" "$TARGET_ADDRESS" 2>/dev/null)

if [ -z "$BALANCE" ]; then
    echo "Warning: Could not get balance - chain may not be ready"
else
    echo "Balance of $TARGET_ADDRESS:"
    echo "  Expected: $EXPECTED_BALANCE wei"
    echo "  Actual:   $BALANCE wei"

    if [ "$BALANCE" = "$EXPECTED_BALANCE" ]; then
        echo "Balance matches! State synced correctly."
    elif [ "$BALANCE" = "0" ]; then
        echo "Warning: Balance is 0 - chain may still be syncing"
    fi
fi

# Save RPC URL to fuji-info.json
jq --arg rpc "$RPC_URL" '.rpcNodeUrl = $rpc' ./fuji-info.json > ./fuji-info-new.json
mv ./fuji-info-new.json ./fuji-info.json

echo ""
echo "=========================================="
echo "Fuji RPC Node Bootstrap Complete!"
echo ""
echo "RPC Node ID:  $RPC_NODE_ID"
echo "RPC URL:      $RPC_URL"
echo "Container:    $CONTAINER_NAME"
echo ""
echo "View logs:  docker logs -f $CONTAINER_NAME"
echo "Stop node:  docker stop $CONTAINER_NAME"
echo ""
echo "fuji-info.json updated with rpcNodeUrl"
echo "=========================================="
echo ""
echo "Run ./8_verify.sh to verify the transplanted state."
