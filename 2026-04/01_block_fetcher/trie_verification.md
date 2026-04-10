# Trie Verification Layer

## Purpose

Verify that our block execution produces the correct `stateRoot` by maintaining an incremental trie. This is the only purpose — no proof serving, no historical trie queries, no state reads from the trie.

## Architecture

Steal reth's approach: the trie is not a data structure in memory. It is a computation over sorted data in a database.

We store intermediate branch node hashes in the DB, keyed by their nibble path. To compute a state root after a block, we walk the stored nodes in sorted order, skip unchanged subtrees, recompute hashes only for paths that were touched, and feed everything into a streaming hash builder that produces the root.

## Database: MDBX

B+ tree, memory-mapped. Sorted iteration is native and fast — exactly what the trie walk needs. Proven at scale by both reth and Erigon for Ethereum state.

Go bindings: `github.com/erigontech/mdbx-go` or Erigon's higher-level `kv/mdbx` wrapper.

## Tables

Four MDBX named databases:

| Table | Key | Value | Purpose |
|-------|-----|-------|---------|
| `AccountState` | `keccak(address)` [32B] | RLP-encoded account (nonce, balance, storageRoot, codeHash) | Flat current state for execution |
| `StorageState` | `keccak(address) ++ keccak(slot)` [64B] | Storage value [32B] | Flat current state for execution |
| `AccountTrie` | `nibble_path` [0-64 nibbles, packed] | `BranchNodeCompact` | Intermediate account trie nodes |
| `StorageTrie` | `keccak(address) ++ nibble_path` [32B + 0-64 nibbles] | `BranchNodeCompact` | Intermediate storage trie nodes per account |

All keys sort lexicographically. This gives us the exact iteration order the trie algorithm needs.

### BranchNodeCompact

Encoding for an intermediate branch node:

```
state_mask:   u16    — which of the 16 children exist
tree_mask:    u16    — which children have subtrees stored in the DB
hash_mask:    u16    — which children have hashes stored in this node
hashes:       [][32]byte — packed child hashes, one per set bit in hash_mask
root_hash:    [32]byte (optional) — cached hash of this node itself
```

This is a direct port of reth's `BranchNodeCompact`. It's compact because it only stores hashes for children that exist, using bitmasks to index them.

### Key Encoding: Nibble Paths

A nibble path is the hex-encoded key prefix that identifies a position in the trie. For a key like `0xABCD...`, the nibble path to the second level is `[A, B]`.

Packed encoding: two nibbles per byte, with a length prefix or odd-nibble flag. Same as Ethereum's compact/hex prefix encoding.

## Algorithm: Block Verification

### Input

- Block header (contains expected `stateRoot`)
- Execution result: set of changed keys
  - Changed accounts: `Set<keccak(address)>`
  - Changed storage: `Map<keccak(address), Set<keccak(slot)>>`
  - Destroyed accounts: `Set<keccak(address)>`

### Steps

```
1. Build PrefixSet from changed keys
   - Sort changed account key nibbles into a flat sorted vec
   - Per account with storage changes, sort changed slot key nibbles

2. For each account with changed storage:
   a. Open cursor on StorageTrie (scoped to this account's prefix)
   b. Open cursor on StorageState (scoped to this account's prefix)
   c. Walk both cursors in nibble order:
      - Branch node from StorageTrie whose prefix is NOT in PrefixSet
        → skip subtree, feed cached hash to HashBuilder
      - Branch node whose prefix IS in PrefixSet
        → descend (don't skip)
      - Leaf from StorageState
        → feed to HashBuilder as leaf
   d. HashBuilder produces:
      - storage root hash for this account
      - list of updated/removed StorageTrie nodes
   e. Write storage trie node updates back to StorageTrie table

3. Walk account trie:
   a. Open cursor on AccountTrie
   b. Open cursor on AccountState
   c. Same dual-cursor merge as above:
      - Skip unchanged branches (not in PrefixSet)
      - For each account leaf, encode it with the storage root from step 2
      - Feed to HashBuilder
   d. HashBuilder produces:
      - account state root hash
      - list of updated/removed AccountTrie nodes
   e. Write account trie node updates back to AccountTrie table

4. Compare computed root to block header stateRoot
   - Match: commit all writes (flat state + trie nodes)
   - Mismatch: execution bug detected, halt/alert
```

### PrefixSet

Directly stolen from reth. A sorted, deduplicated list of nibble paths with a cursor for efficient sequential `contains_prefix` lookups.

```go
type PrefixSet struct {
    keys  []Nibbles  // sorted, deduplicated
    index int        // cursor position for sequential access
}

// ContainsPrefix returns true if any key in the set starts with the given prefix.
// Exploits sorted order + cursor to avoid re-scanning from the beginning.
func (ps *PrefixSet) ContainsPrefix(prefix Nibbles) bool
```

### HashBuilder

Port of alloy_trie's HashBuilder. This is the core engine:

- Receives leaves and branches in sorted nibble order
- Maintains an internal stack of RLP-encoded nodes
- Computes hashes bottom-up as it processes entries
- Emits updated branch nodes as a side effect

This is the most complex single component (~500-800 lines). It handles:
- RLP encoding of branch/extension/leaf nodes
- Keccak hashing when encoded node >= 32 bytes
- Tracking which nodes are new/updated for persistence

### Dual-Cursor Walk (TrieWalker + NodeIter)

The merge logic that drives the HashBuilder:

```
walker   = cursor over AccountTrie (or StorageTrie)
hashed   = cursor over AccountState (or StorageState)

loop:
  if walker.key < hashed.key:
    if walker.key prefix NOT in prefix_set:
      feed cached hash to hash_builder
      skip subtree in walker
    else:
      descend in walker (process children)
  else:
    feed hashed.value as leaf to hash_builder
    advance hashed cursor
```

The walker manages a stack of branch nodes being traversed, handling descent/ascent through the trie structure. It reads `BranchNodeCompact` from the DB to know which children exist and what their cached hashes are.

## Block Processing Flow

### Happy Path (normal block)

```
receive block N
  → execute on flat state (in memory / staging)
  → collect changed keys
  → run trie verification algorithm
  → computed root matches header root
  → COMMIT: write flat state changes + trie node updates to MDBX (single transaction)
```

MDBX transactions are atomic. Either everything is written or nothing is. The flat state and trie nodes are always consistent.

### Mismatch (execution divergence)

```
  → computed root does NOT match header root
  → ABORT: discard all pending writes
  → log/alert with block number, expected root, computed root
  → halt or retry with different execution parameters
```

Since we haven't committed anything, the DB is still at block N-1 state. Clean.

### Rollback / Block Cancellation

MDBX supports read-write transactions. The entire block processing happens inside one transaction:

```go
tx, _ := env.BeginTxn(nil, 0)

// ... execute block, update flat state, run trie verification ...

if rootMatches {
    tx.Commit()  // atomic commit of everything
} else {
    tx.Abort()   // discard everything, DB unchanged
}
```

There is no "undo" needed. We never write partial state. The transaction IS the rollback mechanism.

If we need to roll back an already-committed block (e.g., chain reorg), that's a different problem — we'd need the changeset (old values) to reverse the writes. For now, we don't handle reorgs. If a reorg happens, we re-sync from a checkpoint or re-process from the fork point.

### Reorgs (future consideration)

If we later need reorg support:
- Store per-block changesets: `{key → old_value}` for each write
- To revert block N: apply the changeset in reverse, then delete the changeset
- This naturally leads into the hot window / historical layer

Not implementing this now. The trie verification layer assumes linear block processing.

## Initialization / Cold Start

Two scenarios:

### 1. Starting from scratch (syncing from genesis or a snapshot)

- Fetch state from an existing node or state snapshot
- Insert all accounts and storage into flat state tables
- Build the trie from scratch by walking all flat state in sorted order through the HashBuilder
- This is slow (full 60GB+ state) but only happens once

### 2. Restart after shutdown

- MDBX is crash-safe. On restart, the DB is at the last committed block.
- Read the head block number from a metadata key.
- Resume fetching and processing from head + 1.
- No trie rebuild needed. The intermediate nodes are already persisted.

## Performance Characteristics

### Per-block cost

- Trie computation: O(changed_keys × trie_depth)
  - Typical block: ~100-1000 changed keys
  - Trie depth: ~10-15 levels
  - So ~1000-15000 node reads + hash computations
- Hash operations: ~1000-15000 keccak256 calls per block
- DB reads: sequential cursor walks, cache-friendly
- DB writes: only changed branch nodes, typically ~100-1000

### Memory usage

- MDBX maps the DB into virtual memory. OS page cache handles what's hot.
- Working set per block is small: the touched trie paths.
- With 128GB RAM, the entire DB stays in page cache after warmup.
- Explicit memory allocation is minimal: PrefixSet, HashBuilder stack, cursor buffers.

### Disk usage

- Flat state: ~60GB (same as any node)
- AccountTrie: ~1-3GB (branch nodes only, no leaves)
- StorageTrie: ~3-7GB (branch nodes for all storage tries)
- Total overhead for trie verification: ~4-10GB on top of flat state

## What We Port from Reth

| Component | Reth location | Complexity | Notes |
|-----------|--------------|------------|-------|
| PrefixSet | `trie/common/src/prefix_set.rs` | ~200 lines | Direct port |
| BranchNodeCompact | `trie/common/src/` | ~150 lines | Encoding/decoding |
| HashBuilder | `alloy_trie` (external) | ~800 lines | Most complex piece |
| TrieWalker | `trie/trie/src/walker.rs` | ~300 lines | Cursor + stack management |
| NodeIter | `trie/trie/src/node_iter.rs` | ~150 lines | Dual-cursor merge |
| StateRoot | `trie/trie/src/trie.rs` | ~300 lines | Top-level orchestration |

Total: ~2000 lines of Go, roughly.

## What We Skip

- Resumable computation (reth's threshold/yield mechanism)
- In-memory trie overlay (reth's `InMemoryTrieCursor`)
- Sparse trie (reth's simulation support)
- Multiple DB backend abstractions
- Parallel storage root computation (can add later)
- Historical trie storage
- Proof generation/serving
