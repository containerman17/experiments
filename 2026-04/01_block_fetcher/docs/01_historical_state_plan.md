# Plan: Historical State Storage with MDBX

## Context

The `01_block_fetcher` project fetches raw C-Chain blocks via P2P into PebbleDB. We're adding EVM execution + historical state storage so we can serve `eth_call` at any past block.

First milestone: process blocks 0-1000 from genesis, record historical state, verify by comparing balance/storage lookups against the archival RPC from `.env`.

## Key Decisions

- **Own StateDB**: Write a new `vm.StateDB` implementation backed by MDBX. No reuse of defi-toolbox's in-memory StateDB — different requirements (persistence, no RPC fetching).
- **Memory overlay + flush**: During block execution, reads hit MDBX, writes buffer in Go maps. Flush to MDBX after block commits. Snapshot/revert via journal (same pattern as CallState).
- **Genesis**: Hardcode C-Chain genesis allocations in the binary.
- **Sequential from block 0**: Process all blocks in order. First 1000 is the test milestone.
- **Trie verification on every block**: Compute stateRoot after execution, compare to block header. If mismatch, abort. See `trie_verification.md` for the reth-style algorithm (PrefixSet, HashBuilder, dual-cursor walk).

## MDBX Tables (from storage_design.md)

| Table | Key | Value |
|-------|-----|-------|
| `Blocks` | `blockNumber [8B]` | raw RLP block bytes |
| `BlockIndex` | `blockHash [32B]` | `blockNumber [8B]` |
| `AccountState` | `address [20B]` | RLP(nonce, balance, codeHash) |
| `Code` | `codeHash [32B]` | contract bytecode |
| `StorageState` | `address [20B] ++ slot [32B]` | value (leading zeros stripped) |
| `AddressIndex` | `address [20B]` | `addressID [4B]` |
| `SlotIndex` | `addressID [4B] ++ slot [32B]` | `slotID [4B]` |
| `Changesets` | `blockNumber [8B]` | ZSTD blob (all changes in block) |
| `HistoryIndex` | `keyID [8B] ++ shardMaxBlock [8B]` | roaring bitmap |
| `Metadata` | string key | varies |
| `AccountTrie` | `nibble_path [var]` | `BranchNodeCompact` |
| `StorageTrie` | `keccak(address) [32B] ++ nibble_path [var]` | `BranchNodeCompact` |

## Files to Create

### `store/` package — MDBX storage layer

**`store/db.go`** — MDBX environment + table setup
- `type DB struct` wrapping mdbx env
- `Open(path string) (*DB, error)` — open env, create all named databases
- `BeginRW() / BeginRO()` — transaction helpers
- Table handle constants

**`store/keys.go`** — Key encoding helpers
- `BlockKey(num uint64) [8]byte` — big-endian
- `StorageKey(addr, slot) [52]byte`
- `KeyIDEncode(addressID uint32, slotID uint32) uint64` — 30/34 bit split
- `KeyIDDecode(id uint64) (addressID, slotID)`
- `HistoryKey(keyID uint64, shardMax uint64) [16]byte`

**`store/blocks.go`** — Block storage (replaces PebbleDB)
- `PutBlock(tx, num, hash, raw)`
- `GetBlockByNumber(tx, num) → raw`
- `GetBlockByHash(tx, hash) → raw`
- `GetHeadBlock(tx) → num`
- `SetHeadBlock(tx, num)`

**`store/state.go`** — Flat state CRUD
- `GetAccount(tx, addr) → (nonce uint64, balance *uint256.Int, codeHash common.Hash, exists bool)`
- `PutAccount(tx, addr, nonce, balance, codeHash)`
- `GetCode(tx, codeHash) → []byte`
- `PutCode(tx, codeHash, code)`
- `GetStorage(tx, addr, slot) → common.Hash`
- `PutStorage(tx, addr, slot, value)`

**`store/keydict.go`** — Key dictionary (30/34 bit split)
- `GetOrAssignKeyID(tx, addr, slot) → uint64`
- Internal: sequential addressID counter, per-address slotID counter
- Counters stored in Metadata table

**`store/history.go`** — Changesets + HistoryIndex
- `type Change struct { KeyID uint64; OldValue []byte }`
- `WriteChangeset(tx, blockNum, changes []Change)` — encode + ZSTD compress
- `ReadChangeset(tx, blockNum) → []Change` — decompress + decode
- `UpdateHistoryIndex(tx, keyID, blockNum)` — append to roaring bitmap shard
- `LookupHistorical(tx, addr, slot, blockNum) → (value, error)` — full 4-step lookup
- Shard management: 2000 entries max, seal + create new sentinel

### `trie/` package — State root verification (ported from reth)

**`trie/nibbles.go`** — Nibble path encoding/decoding
- `type Nibbles []byte` — half-byte path representation
- Pack/unpack to bytes, compact encoding for DB keys

**`trie/prefixset.go`** — PrefixSet (~200 lines, direct port from reth)
- Sorted deduplicated nibble paths with cursor
- `ContainsPrefix(prefix) bool` — sequential access optimization

**`trie/branchnode.go`** — BranchNodeCompact encoding (~150 lines)
- `state_mask`, `tree_mask`, `hash_mask` (u16 each)
- Packed child hashes, optional root hash
- Encode/decode to bytes

**`trie/hashbuilder.go`** — HashBuilder (~800 lines, port from alloy_trie)
- Streaming bottom-up hash computation
- Receives sorted leaves + branches, produces root hash
- RLP encoding of branch/extension/leaf nodes
- Keccak256 hashing
- Emits updated branch nodes for persistence

**`trie/walker.go`** — TrieWalker (~300 lines)
- Cursor + stack over AccountTrie / StorageTrie tables
- Reads BranchNodeCompact from MDBX
- Manages descent/ascent through trie structure

**`trie/nodeiter.go`** — Dual-cursor merge (~150 lines)
- Merges walker (trie nodes) + flat state cursor
- Drives the HashBuilder with sorted entries
- Skips unchanged subtrees via PrefixSet

**`trie/stateroot.go`** — Top-level orchestration (~300 lines)
- `ComputeStateRoot(tx, changedKeys) → (hash, trieUpdates, error)`
- Walks storage tries for changed accounts, then account trie
- Returns root hash + list of trie node updates to write

### `executor/` package — Block execution

**`executor/statedb.go`** — `vm.StateDB` implementation backed by MDBX
- `type StateDB struct` with:
  - `tx` — MDBX read-only transaction for reads
  - `storageOverrides map[addr]map[slot]value` — write buffer
  - `balanceOverrides map[addr]*uint256.Int`
  - `nonceOverrides map[addr]uint64`
  - `codeOverrides map[addr][]byte`
  - `journal []journalEntry` — for snapshot/revert
  - Standard EVM plumbing: access list, refund, logs, transient storage
- Reads: check override maps first, then MDBX
- Writes: go to override maps + journal entry
- `Snapshot() / RevertToSnapshot()` — journal-based
- `CollectChanges() → []Change` — diff overrides vs MDBX values (for changeset recording)

**`executor/executor.go`** — Block executor loop
- `type Executor struct` with DB handle, chain config
- `ProcessBlock(blockNum) error`:
  1. Read raw block from MDBX Blocks table
  2. Parse: proposerVM wrapper → inner ETH block → header + txs
  3. Begin MDBX RO tx for reads, create StateDB overlay
  4. Build BlockContext (header, coinbase, basefee, etc.)
  5. For each tx: `corethcore.TransactionToMessage` → `corethcore.ApplyMessage`
  6. After all txs: `statedb.CollectChanges()` to get old+new values
  7. Trie verification:
     - Build PrefixSet from changed keys
     - `trie.ComputeStateRoot(tx, changedKeys)` → root hash + trie node updates
     - Compare root to block header stateRoot
     - If mismatch: abort, log error
  8. Begin MDBX RW tx:
     - Write new flat state values
     - Write trie node updates (AccountTrie, StorageTrie)
     - Write changeset blob (ZSTD compressed)
     - Update history index
     - Assign keyIDs for new keys
     - Update head block metadata
  9. Commit RW tx
- `Run(fromBlock, toBlock)` — loop calling ProcessBlock

**`executor/genesis.go`** — C-Chain genesis loading
- Hardcoded genesis allocations (or loaded from embedded JSON)
- `LoadGenesis(tx)` — write all genesis accounts/balances/code/storage to flat state

**`executor/blockctx.go`** — Block context construction
- Adapted from `thin_client.go:1288-1340`
- `BuildBlockContext(header, chainCfg) → vm.BlockContext`
- Handles Shanghai difficulty→random conversion, custom header extras

### `cmd/verify_history/main.go` — Test tool

- Load `.env` for `ARCHIVAL_RPC_URL`
- Open MDBX database
- For blocks 1-1000:
  - Read changeset to find which keys changed
  - For each changed key: query `eth_getStorageAt(addr, slot, blockNum)` / `eth_getBalance(addr, blockNum)` from archival RPC
  - Look up same value from local historical state via `store.LookupHistorical`
  - Compare, report mismatches
- Summary: X blocks checked, Y keys compared, Z mismatches

### Modifications to `main.go`

- Replace PebbleDB imports with `store/` package
- Block writer goroutine writes to MDBX via `store.PutBlock()`
- Add executor goroutine: `executor.Run()` processing blocks as they arrive
- Keep all existing P2P fetching logic unchanged

## Execution Order

1. **`store/db.go` + `store/keys.go`** — Foundation: MDBX open, table creation, key encoding
2. **`store/blocks.go`** — Block storage so the fetcher can write to MDBX
3. **`main.go` changes** — Swap PebbleDB → MDBX for block storage. Verify fetcher still works.
4. **`store/state.go`** — Flat state CRUD
5. **`executor/genesis.go`** — Load genesis allocations into flat state
6. **`executor/statedb.go`** — vm.StateDB implementation with overlay + journal
7. **`executor/blockctx.go`** — Block context construction
8. **`trie/` package** — All trie verification files (nibbles, prefixset, branchnode, hashbuilder, walker, nodeiter, stateroot)
9. **`executor/executor.go`** — Block executor loop with trie verification
10. **`store/keydict.go`** — Key dictionary
11. **`store/history.go`** — Changesets + history index
12. **Wire executor into main.go** — Run executor goroutine alongside fetcher
13. **`cmd/verify_history/main.go`** — Test against archival RPC
14. **Run and fix** — Process blocks 0-1000, verify state roots match + historical lookups correct

## Dependencies to Add

```
github.com/erigontech/mdbx-go      — MDBX Go bindings
github.com/klauspost/compress/zstd  — ZSTD compression  
github.com/RoaringBitmap/roaring/v2 — Roaring bitmaps
github.com/joho/godotenv            — .env loading (for test tool)
```

## Verification

1. Fetch first 1000+ blocks via P2P into MDBX
2. Execute blocks 0-1000 (genesis → block 1000) — each block's stateRoot must match the header
3. Run `cmd/verify_history/` comparing our historical lookups against archival RPC at `.env`
4. Success = all 1000 state roots match + zero mismatches on historical balance/storage/nonce queries
