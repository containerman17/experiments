# Storage Design

## Overview

A compact, non-validating Avalanche C-Chain node. One MDBX database, three concerns:

1. **Current flat state** — what the EVM reads during execution
2. **Trie verification** — incremental stateRoot computation to catch execution bugs
3. **Historical state** — query any account/slot at any past block

Single MDBX instance. Memory-mapped, 128GB RAM, everything stays in page cache after warmup. Atomic transactions across all tables.

## Key Dictionary

### Why

Historical state tables (HistoryIndex, Changesets) reference `(address, slot)` pairs repeatedly. Raw keys are 52 bytes (`address [20B] ++ slot [32B]`). These are hashes — random, incompressible. MDBX has no key prefix compression. Without a dictionary, HistoryIndex alone wastes ~44 extra bytes per entry across billions of entries.

A dictionary maps `(address, slot)` → `keyID [8B]`, shrinking HistoryIndex keys from 60B to 16B and improving ZSTD compression on changeset blobs (sequential IDs compress much better than random hashes).

### keyID structure: uint64 with 30/34 bit split

```
keyID [8 bytes, uint64] = addressID [30 bits] << 34 | slotID [34 bits]
```

- **addressID** (30 bits): up to 1B unique addresses. Current C-Chain has ~54M. ~18x headroom.
- **slotID** (34 bits): up to 17B unique slots per address. Current C-Chain has ~0.9B total slots across ~54M addresses. ~18x headroom.
- Both sides have roughly equal headroom by design (solved for equal growth margin).
- uint64 — clean alignment, native Go type, no awkward byte packing.

### Dictionary tables

| Table | Key | Value |
|-------|-----|-------|
| `AddressIndex` | `address` [20B] | `addressID` [4B, only 30 bits used] |
| `SlotIndex` | `addressID [4B] ++ slot [32B]` [36B] | `slotID` [4B, only 34 bits used] |

Two lookups to resolve a key. But AddressIndex is tiny (~54M entries, a few hundred MB) — always fully cached. SlotIndex key is 36B instead of 52B because the address is already resolved.

No reverse tables. The only use case for this node is serving `eth_call` — all queries start from `(address, slot)`, never from a keyID. If we ever need "what changed in block N" with human-readable keys, we add a reverse table then.

Assignment is write-once: new addressID/slotID assigned sequentially on first encounter, never changes.

## MDBX Tables

Nine tables, all plain key-value (no DupSort).

### Current State

| Table | Key | Value |
|-------|-----|-------|
| `AccountState` | `address` [20B] | RLP account (nonce, balance, storageRoot, codeHash) |
| `StorageState` | `address [20B] ++ slot [32B]` [52B] | Storage value [1-32B, stripped leading zeros] |

Plain and simple. Full 52-byte key on StorageState means the address repeats for every slot of the same contract. ~20GB of redundant address bytes at ~1B slots. Don't care — it's 60GB total, fits in RAM, one `Get()` per SLOAD.

No DupSort, no prefix compression, no cleverness. One B+ tree seek per lookup.

### Trie Verification

| Table | Key | Value |
|-------|-----|-------|
| `AccountTrie` | `nibble_path` [0-64 nibbles, packed] | `BranchNodeCompact` |
| `StorageTrie` | `keccak(address) [32B] ++ nibble_path` [32B + var] | `BranchNodeCompact` |

Intermediate branch nodes for the Merkle Patricia Trie. Used only to compute stateRoot after each block. See `trie_verification.md` for the algorithm.

Note: trie tables use `keccak(address)` because the MPT requires hashed keys for its structure. Flat state tables use raw `address` because the EVM works with raw addresses.

#### BranchNodeCompact

```
state_mask:   u16    — which of the 16 children exist
tree_mask:    u16    — which children have subtrees stored in the DB
hash_mask:    u16    — which children have hashes stored in this node
hashes:       [][32]byte — packed child hashes, one per set bit in hash_mask
root_hash:    [32]byte (optional) — cached hash of this node itself
```

### Key Dictionary

| Table | Key | Value |
|-------|-----|-------|
| `AddressIndex` | `address` [20B] | `addressID` [4B] |
| `SlotIndex` | `addressID [4B] ++ slot [32B]` [36B] | `slotID` [4B] |

See Key Dictionary section above for details.

### Historical State

| Table | Key | Value |
|-------|-----|-------|
| `Changesets` | `blockNumber` [8B] | ZSTD-compressed blob of all changes in that block |
| `HistoryIndex` | `keyID [8B] ++ shardMaxBlock [8B]` [16B] | Roaring bitmap of block numbers |
| `Metadata` | string key | varies (head block, sync state, etc.) |

## Changesets

One entry per block. The value is a single ZSTD-compressed blob containing all state changes in that block.

### Blob format (before compression)

```
num_changes:  u32
for each change:
    keyID:    [8B]
    value:    [length-prefixed, leading zeros stripped]
```

Changes are encoded with keyIDs (not raw addresses/slots). This means:
- 8 bytes per key instead of 52
- keyIDs are sequential-ish numbers — ZSTD compresses these much better than random hashes
- Addresses within one block's changes are already resolved, so same-contract changes have adjacent keyIDs (addressID is the high bits)

Values have leading zeros stripped before encoding, then the whole blob is ZSTD-compressed.

### ZSTD dictionary

Train a ~64KB ZSTD dictionary on a sample of real C-Chain blocks. Ship it in the binary. The dictionary captures common keyID patterns and value shapes. Improves compression ratio from ~5x to ~8x on typical blocks.

### Size estimates (1000 changes/block average)

| Approach | Per block | Per year |
|----------|----------|----------|
| Raw uncompressed (52B keys) | 84 KB | 1.3 TB |
| keyIDs + strip zeros + ZSTD | ~8 KB | 126 GB |
| keyIDs + strip zeros + ZSTD + trained dict | ~6 KB | 95 GB |

### Why store old values, not new values

The changeset stores the value **before** the block modified it. Reasons:
- Rollback: just write old values back, done
- Latest value is always in flat state — no changeset lookup needed for head queries
- Historical query at block N needs the value before the next change, which is the old value at that change

## History Index

Stolen from reth. Per key, a sharded list of block numbers where that key changed.

Each shard holds up to 2000 block numbers in a roaring bitmap. The shard key includes the highest block number in that shard, so a DB seek lands in the right shard.

```
keyID=42, shard covering up to block 500000:
  key:   [42][500000]            ← 16 bytes total
  value: roaring_bitmap{100, 350, 1200, 4500, ..., 499800}

keyID=42, latest shard:
  key:   [42][0xFFFFFFFFFFFFFFFF]
  value: roaring_bitmap{500100, 500400, ...}
```

The `0xFFFFFFFFFFFFFFFF` sentinel marks the open-ended latest shard. When it exceeds 2000 entries, seal it with the actual max block and create a new sentinel.

Compare: without key dictionary this would be 60-byte keys. With dictionary: 16-byte keys. 3.75x saving on a table that grows forever.

## Historical Lookup: "what was (address, slot) at block N?"

```
1. addressID = get(AddressIndex, address)
   slotID = get(SlotIndex, addressID ++ slot)
   keyID = addressID << 34 | slotID
   → if not found at any step: key never existed, return zero

2. seek(HistoryIndex, keyID ++ N)
   → returns shard with maxBlock >= N
   → decompress roaring bitmap
   → binary search for first block >= N, call it B

3. if B found:
   → get(Changesets, B)
   → ZSTD decompress the blob
   → scan for keyID in the decompressed entries
   → return the old value (= what was live at block N)

4. if no B found (no block >= N ever changed this key):
   → get(StorageState, address ++ slot)
   → return current value (it hasn't changed since block N)
```

Four lookups + one decompress. Not on the hot path — historical queries have generous latency budget.

## Block Processing Flow

```
receive block N
│
├─ begin MDBX read-write transaction
│
├─ execute block
│  ├─ EVM reads from AccountState / StorageState via Get()
│  ├─ collect changes: [(address, slot, oldValue, newValue)]
│  └─ write new values to AccountState / StorageState
│
├─ record history
│  ├─ for each change: resolve keyID via AddressIndex + SlotIndex
│  │   (assign new IDs if first encounter)
│  ├─ encode changes as keyID + stripped value, ZSTD compress
│  ├─ put(Changesets, blockNumber, compressedBlob)
│  └─ for each changed keyID: update HistoryIndex bitmap
│
├─ trie verification
│  ├─ build PrefixSet from changed keys
│  ├─ dual-cursor walk over trie nodes + flat state
│  ├─ HashBuilder computes stateRoot
│  └─ write updated trie nodes
│
├─ compare computed stateRoot to block header
│  ├─ match → tx.Commit()
│  └─ mismatch → tx.Abort(), halt/alert
│
└─ update Metadata (head block number/hash)
```

One MDBX transaction. Atomic commit or abort. No partial state.

## Reorg Handling

To revert block N:

```
1. get(Changesets, N) → ZSTD decompress
2. for each (keyID, oldValue) in blob:
   → resolve keyID back to (address, slot)
     (requires reverse lookup — either add reverse tables or
      store raw address+slot alongside keyID in the blob)
   → put(StorageState, address ++ slot, oldValue)
3. for each changed keyID: remove block N from HistoryIndex bitmap
4. delete(Changesets, N)
5. revert trie (re-run verification on reverted state)
6. update Metadata to block N-1
```

Note: reorg requires resolving keyID → (address, slot) to write back to flat state. Two options:
- Store raw address+slot in the changeset blob alongside keyID (increases blob size but self-contained)
- Add reverse lookup tables (only needed if reorgs actually happen)

For now: store both keyID and raw address+slot in the blob. The ZSTD compression eats the redundancy. Reorgs are rare; simplicity wins.

## Disk Usage Estimates

| Table | Size | Growth |
|-------|------|--------|
| AccountState | ~5 GB | ~1-2 GB/year |
| StorageState | ~55 GB | ~10-20 GB/year |
| AccountTrie | ~1-3 GB | tracks state size |
| StorageTrie | ~3-7 GB | tracks state size |
| AddressIndex | ~0.5 GB | negligible |
| SlotIndex | ~5-8 GB | ~1-2 GB/year |
| Changesets | — | ~95-126 GB/year |
| HistoryIndex | — | ~15-30 GB/year |
| **Total at sync** | **~70-80 GB** | **before historical accumulation** |

Historical data (Changesets + HistoryIndex) grows linearly with chain age. With keyID compression + ZSTD, full C-Chain history (since 2020) estimated at ~500-800 GB.

## Dependencies

| Component | Package |
|-----------|---------|
| MDBX | `github.com/erigontech/mdbx-go` |
| ZSTD | `github.com/klauspost/compress/zstd` |
| Roaring bitmaps | `github.com/RoaringBitmap/roaring` |
| Trie algorithm | Ported from reth (see `trie_verification.md`) |

## What We Skip

- DupSort (not worth the complexity at 60GB flat state)
- Reverse key dictionary (no use case — all queries start from address+slot)
- Separate DB for historical data (one MDBX for everything)
- Static files / segment files (add if MDBX struggles at TB scale)
- Hot window / recent block cache (bolt on later)
- Proof serving
- State sync serving
