#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Step 3: Stopping Source Network ==="

# Read chain ID before stopping
if [ -f ./source-info.json ]; then
    SOURCE_CHAIN_ID=$(jq -r '.chainId' ./source-info.json)
    echo "Source chain ID: $SOURCE_CHAIN_ID"
    echo "$SOURCE_CHAIN_ID" > ./source-chain-id.txt
else
    echo "Warning: source-info.json not found"
fi

# Container names
CONTAINER_NODE0="source_node0"
CONTAINER_NODE1="source_node1"
CONTAINER_L1="source_l1_validator"

# Stop and remove containers
echo "Stopping source network containers..."
for container in "$CONTAINER_L1" "$CONTAINER_NODE1" "$CONTAINER_NODE0"; do
    if docker ps -a --format '{{.Names}}' | grep -q "^${container}$"; then
        echo "  Stopping $container..."
        docker stop "$container" 2>/dev/null || true
        docker rm "$container" 2>/dev/null || true
    fi
done

echo ""
echo "Source network stopped."
echo "Chain data is preserved in ./source_network/"
echo ""
echo "Run ./4_prepare_fuji_node.sh to prepare the Fuji validator node"
