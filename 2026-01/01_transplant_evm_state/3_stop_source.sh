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

# Stop the network
go run ./cmd/network stop --info ./source-info.json

echo ""
echo "Source network stopped."
echo "Chain data is preserved in ./source_network/"
echo ""
echo "Run ./4_transplant.sh to start target network and transplant state"
