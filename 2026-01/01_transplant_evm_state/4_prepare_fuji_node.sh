#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=========================================="
echo "=== Step 4: Prepare Fuji Validator Node ==="
echo "=========================================="
echo ""

# Verify source data exists
if [ ! -f ./source-chain-id.txt ]; then
    echo "Error: source-chain-id.txt not found. Run steps 1-3 first."
    exit 1
fi

SOURCE_CHAIN_ID=$(cat ./source-chain-id.txt)
echo "Source chain ID (local): $SOURCE_CHAIN_ID"

# Verify source chain data exists
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
    exit 1
fi

echo "Source chain data: $SOURCE_CHAIN_DATA"
echo ""

# Create Fuji node directory
FUJI_NODE_DIR="./fuji_node"
STAKING_DIR="$FUJI_NODE_DIR/staking"

# Check if keys already exist
if [ -f "$STAKING_DIR/staker.crt" ]; then
    echo "Staking keys already exist at $STAKING_DIR"
    echo "Using existing keys..."
    NODE_ID=$(go run ./cmd/genkeys "$STAKING_DIR" 2>/dev/null | jq -r '.nodeID' || true)

    if [ -z "$NODE_ID" ] || [ "$NODE_ID" = "null" ]; then
        # Re-generate to get node ID
        echo "Regenerating keys to get node ID..."
        rm -rf "$STAKING_DIR"
    fi
fi

if [ ! -f "$STAKING_DIR/staker.crt" ]; then
    echo "Generating new staking keys..."
    rm -rf "$FUJI_NODE_DIR"
    mkdir -p "$FUJI_NODE_DIR/db"
    mkdir -p "$FUJI_NODE_DIR/logs"
    mkdir -p "$FUJI_NODE_DIR/chainData"
    mkdir -p "$STAKING_DIR"

    # Generate staking keys
    KEYS_INFO=$(go run ./cmd/genkeys "$STAKING_DIR")
    echo "$KEYS_INFO" > "$FUJI_NODE_DIR/keys-info.json"
else
    # Load existing keys info
    KEYS_INFO=$(go run ./cmd/genkeys "$STAKING_DIR")
    echo "$KEYS_INFO" > "$FUJI_NODE_DIR/keys-info.json"
fi

NODE_ID=$(jq -r '.nodeID' "$FUJI_NODE_DIR/keys-info.json")
BLS_PUBLIC_KEY=$(jq -r '.blsPublicKey' "$FUJI_NODE_DIR/keys-info.json")
BLS_POP=$(jq -r '.blsProofOfPossession' "$FUJI_NODE_DIR/keys-info.json")

echo ""
echo "=========================================="
echo "NODE INFORMATION FOR FUJI L1 CREATION"
echo "=========================================="
echo ""
echo "Node ID:              $NODE_ID"
echo ""
echo "BLS Public Key:       $BLS_PUBLIC_KEY"
echo ""
echo "BLS Proof of Possession:"
echo "$BLS_POP"
echo ""
echo "Staking keys saved to: $STAKING_DIR/"
echo "  - staker.crt (TLS certificate)"
echo "  - staker.key (TLS private key)"
echo "  - signer.key (BLS signer key)"
echo ""
echo "=========================================="
echo ""
echo "GENESIS FILE (use this when creating your L1):"
echo "=========================================="
echo ""
cat ./genesis.json
echo ""
echo "=========================================="
echo ""
echo "Genesis file location: $(pwd)/genesis.json"
echo ""
echo "=========================================="
echo ""
echo "NEXT STEPS:"
echo ""
echo "1. Go to Avalanche CLI or Core Wallet"
echo ""
echo "2. Create a new L1 on Fuji testnet with:"
echo "   - This node ($NODE_ID) as a validator"
echo "   - SubnetEVM as the VM"
echo "   - The genesis above (or copy from ./genesis.json)"
echo ""
echo "3. After creating the L1, run:"
echo "   ./5_configure_fuji.sh"
echo ""
echo "   You will need to provide:"
echo "   - Subnet ID"
echo "   - Blockchain ID"
echo ""
echo "=========================================="

# Save node info for later
echo "$NODE_ID" > ./fuji-node-id.txt
echo "$BLS_PUBLIC_KEY" > ./fuji-bls-public-key.txt
echo "$BLS_POP" > ./fuji-bls-pop.txt
