# Subnet-EVM state migration (testnet to mainnet)

**Question:** Can we run a Subnet-EVM on testnet, then "port" it to mainnet without losing EVM data?

**Short answer:** Yes, it's possible. Copy the chain's VM directory from testnet nodes to mainnet nodes. **However, you MUST disable the warp precompile** because it exposes the Avalanche blockchain ID to contracts.

---

## Key findings

### 1. Avalanche blockchain ID exposure

The **only** place where the Avalanche blockchain ID (the 32-byte chain ID, not the numeric EVM chain ID) is exposed to EVM contracts is through the **warp precompile**:

```go
// graft/subnet-evm/precompile/contracts/warp/contract.go:139-144
func getBlockchainID(accessibleState contract.AccessibleState, ...) {
    packedOutput, err := PackGetBlockchainIDOutput(
        common.Hash(accessibleState.GetSnowContext().ChainID)  // <-- Avalanche chain ID
    )
}
```

The warp precompile exposes:
- `getBlockchainID()` - returns the Avalanche chain ID directly
- `sendWarpMessage()` - embeds the chain ID in outgoing warp messages  
- `getVerifiedWarpMessage()` - returns `SourceChainID` in the response

**Solution:** Disable warp in genesis OR via upgradeBytes before migration.

### 2. What is NOT a problem

- **`eth_chainId` RPC** - Returns the EVM chain ID from genesis config (`chainId` field). This is the numeric chain ID (e.g., 43114), not the Avalanche blockchain ID. If you use the same genesis, this will be identical.

- **`eth_getChainConfig` RPC** - Returns the chain config from genesis, which only includes the numeric EVM chain ID.

- **Block headers, receipts, state** - Do not contain Avalanche blockchain ID.

- **`AvalancheContext`** - Marked as `json:"-"` in the config struct, meaning it's NOT serialized to disk. It's set at runtime during VM initialization.

- **State sync** - Does not embed chain-specific identifiers.

### 3. No import/export tools exist

There are no built-in export/import tools for state migration. Manual copying of the VM directory is the approach.

---

## Genesis Hash Verification

The VM enforces that the genesis bytes provided at startup match the genesis block stored in the database. This verification happens in `core/genesis.go` via the `SetupGenesisBlock` function:

```go
// core/genesis.go:171-179
hash := genesis.ToBlock().Hash()
if hash != stored {
    return genesis.Config, common.Hash{}, &GenesisMismatchError{stored, hash}
}
```

**Process:**
1. At VM initialization, `SetupGenesisBlock` is called with the genesis JSON
2. The function reads the stored genesis hash from the database at block height 0 using `rawdb.ReadCanonicalHash(db, 0)`
3. It calculates the hash of the provided genesis using `genesis.ToBlock().Hash()`
4. If the hashes don't match, it returns `GenesisMismatchError` and the VM refuses to start

**Implications for migration:**
- **You MUST use the exact same genesis bytes** on mainnet as testnet
- Even a single byte difference (whitespace, ordering) will cause a different hash
- The VM will reject the copied state if genesis hashes don't align
- This is a security feature - prevents loading incompatible or tampered state

**Why this matters:**
The database contains state rooted against the original genesis block's state root. If you provide a different genesis, the state trie structures won't align and the VM cannot validate that the copied state is valid for purported genesis.

---

## How to disable warp

### Option 1: Never enable it in genesis

Don't include `warpConfig` in your genesis:

```json
{
  "config": {
    "chainId": 99999,
    ...
    // No "warpConfig" key = warp is disabled
  },
  ...
}
```

### Option 2: Disable via upgradeBytes

If warp was enabled, disable it via upgradeBytes (chain config file):

```json
{
  "precompileUpgrades": [
    {
      "warpConfig": {
        "blockTimestamp": 1700000000,
        "disable": true
      }
    }
  ]
}
```

From code (`graft/subnet-evm/precompile/contracts/warp/config.go:73-82`):

```go
// NewDisableConfig returns config for a network upgrade at [blockTimestamp]
// that disables Warp.
func NewDisableConfig(blockTimestamp *uint64) *Config {
    return &Config{
        Upgrade: precompileconfig.Upgrade{
            BlockTimestamp: blockTimestamp,
            Disable:        true,
        },
    }
}
```

---

## Migration procedure

### Prerequisites
1. Warp precompile must be disabled (or never enabled) on the testnet chain
2. Same genesis bytes will be used for mainnet

### Steps

1. **Stop testnet nodes** (or at least stop writes to the chain)

2. **Create the subnet on mainnet** with the **exact same genesis bytes** as testnet
   - This yields a new Avalanche chain ID on mainnet (different from testnet)
   - The EVM chain ID (numeric) will be the same since genesis is the same

3. **Copy the VM state directory** on each mainnet validator:
   ```bash
   # Source (testnet):
   #   chainDataDir/<testnet_chain_id>/
   #
   # Destination (mainnet):
   #   chainDataDir/<new_mainnet_chain_id>/
   
   cp -r /path/to/testnet/chainData/<testnet_chain_id>/* \
         /path/to/mainnet/chainData/<new_mainnet_chain_id>/
   ```
   
   Default `chainDataDir`: `~/.avalanchego/chainData/`

4. **Start mainnet nodes**
   - The VM will see the copied state with matching genesis hash
   - It will continue from the copied last accepted block

### Validators
- They do **NOT** need to be the same as testnet
- Just copy the state to every node that will run the subnet on mainnet

---

## Directory structure

```
~/.avalanchego/
├── chainData/                          # --chain-data-dir
│   └── <chain_id>/                     # Per-chain VM directory
│       └── db/                         # Standalone DB (when used)
│           └── pebble/                 # Actual database files
└── db/                                 # Main node DB (don't copy this)
    └── v1.4.5/ or pebble/
```

The VM determines which DB to use:
1. If `acceptedBlockDB` is empty → use standalone DB under `chainDataDir/<chain_id>/db/`
2. If `acceptedBlockDB` has data → use main node DB with prefix

Since you're copying to a fresh mainnet node, it will use the standalone DB pattern.

---

## What you must NOT do

1. **Don't change genesis** - Different genesis = different genesis hash = VM won't accept the copied state

2. **Don't copy the main node DB** (`~/.avalanchego/db/`) - That contains network-wide data (P-chain state, genesis hash verification, etc.)

3. **Don't enable warp on mainnet without proper handling** - Contracts that called `getBlockchainID()` on testnet would get a different value on mainnet

4. **Don't use warp messages from testnet** - They contain the testnet chain ID and won't verify on mainnet

---

## Edge cases and warnings

1. **Contracts that stored the blockchain ID**: If any contract called `getBlockchainID()` on testnet and stored the result, that stored value will be the testnet chain ID. On mainnet, calling `getBlockchainID()` would return a different value. This could break logic that compares stored vs. current blockchain ID.

2. **Warp message history**: Any warp messages sent on testnet are signed with testnet's chain ID and validator set. These cannot be verified on mainnet.

3. **Cross-chain communication**: If the subnet communicated with other chains via warp on testnet, that communication channel won't work on mainnet without re-establishing it.

---

## Code references

- Chain data dir creation: `chains/manager.go` ~482-485, ~514-515
- Standalone DB: `graft/subnet-evm/plugin/evm/vm_database.go` (`getDatabaseConfig`, `useStandaloneDatabase`)
- VM Initialize: `graft/subnet-evm/plugin/evm/vm.go` ~338-356, ~1270-1289
- Warp precompile: `graft/subnet-evm/precompile/contracts/warp/contract.go`
- Warp disable config: `graft/subnet-evm/precompile/contracts/warp/config.go:73-82`
- AvalancheContext not serialized: `graft/subnet-evm/params/extras/config.go:108`
- Genesis hash verification: `graft/subnet-evm/core/genesis.go:171-179` (`SetupGenesisBlock`)
