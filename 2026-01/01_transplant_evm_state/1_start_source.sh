#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Step 1: Starting Source Network ==="

# Clean up any existing network
pkill -f avalanchego 2>/dev/null || true
sleep 1

# Start the source network
go run ./cmd/network start \
    --data-dir ./source_network \
    --output ./source-info.json \
    --validators 1 \
    --background

echo ""
echo "Source network started. Info saved to source-info.json"
echo "Run ./2_populate_state.sh to add test data"
