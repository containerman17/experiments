# Compact Avalanche C-Chain Client — Architecture

## Goal

Minimal-footprint archival C-Chain node targeting < 2TB local disk (+ S3 for blocks).
Must support historical `eth_call`, `eth_getLogs`, `eth_getTransactionByHash`, and full state verification.
Target hardware: 32GB RAM, 3.84TB SSD.

## Chain parameters (mainnet, as of Apr 2026)

- 82M blocks, ~1.2B transactions
- Live state: ~60GB (accounts + storage + code)
- Current reference node (geth-based): ~14TB

## Storage layers

### 1. Block store

Unified abstraction over block storage. Callers see two interfaces:

- **Iterator**: `BlocksFrom(blockNum)` — yields blocks sequentially. The executor
  and group 2 indexer use this. The store handles local packs, S3 fallback, and
  P2P subscription at the tip transparently. Prefetches next pack while caller
  processes current one.
- **Point lookup**: `GetBlock(blockNum)` — returns a single block. Used by RPC
  (`eth_getBlockByNumber`, `eth_getTransactionByHash` after resolving tx location).
  Checks LRU cache → local pack → S3.

Callers never import S3, file, or P2P packages. Just the BlockStore interface.

#### On-disk format: pack files

Each pack contains ~100 blocks. Block bodies compressed independently with ZSTD
(optional shared dictionary per pack for better ratio).

```
[header]
  block_count(4)
  per block: blockNum(8) + offset(8) + compressed_length(4)
[body]
  [block0_zstd][block1_zstd]...
```

Single-block random access: binary search offset table → seek → decompress one block.
Memory: one decompression buffer (~1MB).

#### Storage tiers

- **Local**: pack files on disk during sync. Hot data.
- **S3**: packs uploaded after sync completes, local copies deleted. Cold data.
  Thin local index maps blockNum → S3 key. ~$27/mo for 1.2TB.
- **LRU cache**: recent blocks kept in memory for repeated point lookups.

Block headers (~500 bytes each) are stored separately in group 1 MDBX
(`BlockHeaders` table) since `eth_call` needs the header to build EVM context
(timestamp, baseFee, gasLimit, coinbase). Headers are always local, never offloaded.
82M headers ≈ 40GB.

Estimated size: ~1.2TB block bodies on S3, ~40GB headers local, ~1GB pack index local.

### 2. Group 1 — executor state (single MDBX environment)

All data needed for block execution and historical `eth_call`. Single writer,
must be consistent. This is the critical path.

**Tables:**

| Table | Key | Value | Full chain est. |
|-------|-----|-------|-----------------|
| AccountState | address(20) | nonce+balance+codeHash+storageRoot (105B) | ~3GB |
| StorageState | address(20)+slot(32) | trimmed value | ~50GB |
| Code | codeHash(32) | bytecode | ~1GB |
| HashedAccountState | keccak(addr)(32) | same as AccountState | ~3GB |
| HashedStorageState | keccak(addr)(32)+keccak(slot)(32) | trimmed value | ~50GB |
| AccountTrie | nibble path | branch node (compact) | ~1GB |
| StorageTrie | addrHash(32)+nibble path | branch node (compact) | ~10GB |
| BlockHeaders | blockNum(8) | RLP(header) | ~40GB |
| Changesets | blockNum(8) | LZ4([keyID(8)+oldValueLen(2)+oldValue]*) | ~600GB |
| HistoryIndex | keyID(8)+maxBlock(8) | roaring bitmap | ~140GB |
| KeyDict (AddressIndex) | address(20) | addressID(4) | ~1GB |
| KeyDict (SlotIndex) | addressID(4)+slot(32) | slotID(4) | ~65GB |
| Metadata | string key | misc values | tiny |

Estimated total: ~970GB

**Why one MDBX env:** Changesets, HistoryIndex, and KeyDict must be consistent with
state for historical `eth_call` correctness. Splitting them into a separate env
creates a consistency gap that's hard to manage.

### 3. Group 2 — parallel indexes (separate MDBX environment)

Data not needed for execution or `eth_call`. Can be built/rebuilt independently
by replaying blocks and changesets. Each index is independent — parallelizable.
Separate MDBX env with its own consistency domain and head pointer.

| Table | Key | Value | Full chain est. |
|-------|-----|-------|-----------------|
| TxHashIndex | txHash(32) | blockNum(8)+txIndex(2) | ~50GB |
| ReceiptsByBlock | blockNum(8) | LZ4(encoded receipts) | ~250GB |
| AddressLogIndex | address(20)+maxBlock(8) | roaring bitmap | ~15GB |
| TopicLogIndex | topic(32)+maxBlock(8) | roaring bitmap | ~8GB |
| BlockHashIndex | blockHash(32) | blockNum(8) | ~7GB |
| Metadata | string key | index head block, etc. | tiny |

Estimated total: ~330GB

**Why separate MDBX env:** Own RW lock so index writes never block executor.
Own head pointer so indexes can lag behind state. Own cursors and transaction
lifecycle. Same API as group 1 — no new dependencies, same operational tooling.
Not implemented in v1; placeholder for when indexing is needed.

## Total disk budget

| Layer | Size | Location |
|-------|------|----------|
| Block bodies (packs) | ~1.2TB | S3 ($27/mo) |
| Block pack index | ~1GB | Local |
| Group 1 (MDBX) | ~970GB | Local |
| Group 2 (MDBX env 2) | ~330GB | Local |
| **Local total** | **~1.3TB** | |

Fits on a 2TB disk. Comfortable on 3.84TB with years of growth headroom.

## Execution modes

### Catch-up mode (syncing from genesis)

1. Fetch blocks from peers → write to local pack files
2. Execute blocks in large batches (10K-50K)
3. Write state + changesets to group 1 MDBX
4. Maintain HashedAccountState/HashedStorageState on every write (keccak per put)
5. Incremental trie verification every N batches (TBD: 100K? 1M blocks?)
6. If trie mismatch: roll back using changesets to last verified checkpoint, re-execute
7. Group 2 indexes: built in parallel workers, can lag behind executor

### Live mode (at the tip)

1. Receive new blocks from peers
2. Execute block, write state + changesets
3. Incremental trie verification every block
4. Target: < 100ms per block with 60GB state
5. Group 2 indexes updated in background

### Transition (catch-up → live)

Same code path for both modes. Only difference is batch size:
large during catch-up, 1 per block at tip. Trie verification frequency
is a function of batch size. No mode switch, no special transition logic.

## Historical eth_call flow

1. Caller requests `eth_call(tx, blockNum)`
2. Read block header from BlockHeaders (group 1) → build EVM context
3. Read current state from AccountState/StorageState
4. Look up KeyDict for the touched keys → keyIDs
5. Query HistoryIndex for each keyID → find first changeset after blockNum
6. Read Changesets at those block numbers → get old values
7. Apply old values to reconstruct state at blockNum
8. Execute call against reconstructed state

All data in group 1 MDBX. No S3 round trip. No cross-store coordination.

## Read cache (executor hot set)

Small in-process LRU for recently touched accounts/storage during execution.
~100MB. Saves cgo round trips for hot DeFi contracts (Uniswap pairs, etc.)
that get SLOAD/SSTORE'd every block. Invalidated at batch boundaries.

## Process architecture

```
Process 1: Fetcher
  - P2P block fetching
  - Writes pack files (local or direct to S3)
  - Independent, can run/stop without affecting executor

Process 2: Executor + RPC server
  - Reads blocks from pack files
  - Writes group 1 MDBX
  - Serves JSON-RPC (eth_call, eth_getBalance, etc.)
  - Launches group 2 indexer workers

Process 3 (optional): Index builder
  - Reads blocks + changesets from group 1
  - Writes group 2 MDBX (separate env, own RW lock)
  - Tracks own head block, can lag behind executor
  - Can run on a different machine entirely
```

## Key design principles

- **No redundant data.** Receipts can be re-derived from blocks + state. Stored in
  group 2 only as a serving optimization.
- **Compression at the source.** LZ4 for changesets (fast, write-hot). ZSTD for block
  packs (better ratio, write-once). No DB-level compression.
- **Three consistency domains.** Block packs (immutable once written), group 1
  MDBX (executor state, single writer), group 2 MDBX (indexes, independent writer).
  Each tracks its own head block. On restart each resumes independently.
- **32GB RAM budget.** All random-access state goes through MDBX mmap. OS manages
  page cache. No attempt to hold full state in Go heap.
- **Separate concerns.** Fetching, execution, and indexing are independent processes
  with independent failure modes.
