#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=========================================="
echo "=== Step 5: Configure Fuji L1 Details ==="
echo "=========================================="
echo ""

# Verify prerequisites
if [ ! -f ./fuji-node-id.txt ]; then
    echo "Error: fuji-node-id.txt not found. Run 4_prepare_fuji_node.sh first."
    exit 1
fi

NODE_ID=$(cat ./fuji-node-id.txt)
echo "Node ID: $NODE_ID"
echo ""

# Check if we already have configuration
if [ -f ./fuji-info.json ]; then
    echo "Existing configuration found:"
    cat ./fuji-info.json
    echo ""
    read -p "Do you want to update this configuration? (y/N): " UPDATE
    if [ "$UPDATE" != "y" ] && [ "$UPDATE" != "Y" ]; then
        echo "Using existing configuration."
        echo "Run ./6_start_fuji_transplant.sh to continue."
        exit 0
    fi
fi

echo "Please enter the L1 details from Fuji testnet:"
echo "(These should be from the L1 you created with node $NODE_ID as validator)"
echo ""

# Prompt for Subnet ID
while true; do
    read -p "Subnet ID: " SUBNET_ID
    if [ -z "$SUBNET_ID" ]; then
        echo "Error: Subnet ID cannot be empty"
        continue
    fi
    # Basic validation - should be base58 encoded, around 40-50 chars
    if [[ ! "$SUBNET_ID" =~ ^[a-zA-Z0-9]{40,60}$ ]]; then
        echo "Warning: Subnet ID format looks unusual (expected ~50 alphanumeric chars)"
        read -p "Continue anyway? (y/N): " CONTINUE
        if [ "$CONTINUE" != "y" ] && [ "$CONTINUE" != "Y" ]; then
            continue
        fi
    fi
    break
done

# Prompt for Blockchain ID
while true; do
    read -p "Blockchain ID: " BLOCKCHAIN_ID
    if [ -z "$BLOCKCHAIN_ID" ]; then
        echo "Error: Blockchain ID cannot be empty"
        continue
    fi
    # Basic validation
    if [[ ! "$BLOCKCHAIN_ID" =~ ^[a-zA-Z0-9]{40,60}$ ]]; then
        echo "Warning: Blockchain ID format looks unusual (expected ~50 alphanumeric chars)"
        read -p "Continue anyway? (y/N): " CONTINUE
        if [ "$CONTINUE" != "y" ] && [ "$CONTINUE" != "Y" ]; then
            continue
        fi
    fi
    break
done

echo ""
echo "Configuration summary:"
echo "  Node ID:       $NODE_ID"
echo "  Subnet ID:     $SUBNET_ID"
echo "  Blockchain ID: $BLOCKCHAIN_ID"
echo ""

read -p "Is this correct? (y/N): " CONFIRM
if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
    echo "Aborted. Run this script again to re-enter."
    exit 1
fi

# Save configuration
cat > ./fuji-info.json << EOF
{
  "network": "fuji",
  "networkId": 5,
  "nodeId": "$NODE_ID",
  "subnetId": "$SUBNET_ID",
  "chainId": "$BLOCKCHAIN_ID"
}
EOF

echo ""
echo "Configuration saved to fuji-info.json"
echo ""
echo "=========================================="
echo "Run ./6_start_fuji_transplant.sh to start the"
echo "Fuji node with transplanted state."
echo "=========================================="
