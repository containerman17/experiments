# EVM State Transplant - Implementation

## Overview

Test suite to verify EVM state can be transplanted between two Avalanche L1 chains with different Avalanche chain IDs but identical genesis. Tests both native ETH and ERC20 contract state.

## Files

```
cmd/
  network/main.go    # Start/stop L1 networks
  sendtx/main.go     # Send native ETH
  balance/main.go    # Check native balance
  erc20/main.go      # Deploy/transfer/balance ERC20

1_start_source.sh       # Start source L1
2_populate_state.sh     # Deploy ERC20, send 100k ETH + 500k tokens
3_stop_source.sh        # Stop source, save chain ID
4_transplant.sh         # Start target L1, copy chain data
5_verify.sh             # Verify both balances match
6_post_transplant_tx.sh # Send 1 ETH + 1k tokens to prove chain works

Makefile                # Downloads avalanchego + subnet-evm to bin/
genesis.json            # Subnet-EVM genesis (no warp)
chain-config.json       # pruning-enabled: false
node-config.json        # Logging config
staking/local/          # 6 sets of staking keys
```

## How to Run

```bash
cd /home/ubuntu/experiments/2026-01/01_transplant_evm_state

# 1. Download binaries
make

# 2. Run test sequence
./1_start_source.sh       # Start source L1
./2_populate_state.sh     # Deploy ERC20 + send tokens
./3_stop_source.sh        # Stop source
./4_transplant.sh         # Start target + transplant
./5_verify.sh             # Verify transplanted state
./6_post_transplant_tx.sh # Send more txs to prove chain works

# 3. Cleanup
pkill -f avalanchego
```

## Prerequisites

- Go 1.24+
- jq

No external tools (Foundry, etc.) needed.

## Test Flow

### Step 2: Populate State
- Deploys ERC20 contract
- Sends **100,000 ETH** to `0x1111...1111`
- Sends **500,000 ERC20 tokens** to same address

### Step 5: Verify
- Checks native balance = 100,000 ETH
- Checks ERC20 balance = 500,000 tokens
- Confirms chain IDs are DIFFERENT

### Step 6: Post-Transplant
- Sends **1 ETH** more (balance becomes 100,001 ETH)
- Sends **1,000 tokens** more (balance becomes 501,000 tokens)
- Proves chain is fully functional after transplant

## Expected Output

```
Source Chain ID: 2ABC...xyz
Target Chain ID: 2XYZ...abc   (DIFFERENT!)

Native Balance:
  Expected: 100000000000000000000000 wei
  Actual:   100000000000000000000000 wei
  NATIVE: OK

ERC20 Balance:
  Expected: 500000000000000000000000
  Actual:   500000000000000000000000
  ERC20: OK

SUCCESS! State transplant verified!
```

## Key Points

1. **Genesis must be identical** - same hash required
2. **Warp precompile disabled** - exposes chain ID to contracts
3. **Copy `chainData/<chainId>/db/`** directory
4. **Contract state preserved** - ERC20 balances work
5. **Chain fully functional** - accepts new transactions
