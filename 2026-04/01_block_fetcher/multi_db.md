# Multi-DB & Speed Optimization Notes (2026-04-14)

## Current Performance (batch=10000, block ~8.67M)

Warm-cache steady state:
```
exec=1m56s  flush=2m5s  trie=51s  commit=7ms  rate=34.3 blk/s  519 tx/s
```

Flush breakdown (10K batch):
```
state=7s  changesets=22s  histIdx=36s  receipts=0.7s  logIdx=16s  txIdx=55s
```

## Thread Architecture (3 goroutines)

MDBX allows exactly ONE RW tx at a time. Pipeline:

```
batch N:   [── exec 2m ──][── critical RW: state+trie 61s ──]
batch N-1:                 [── background RW: indexes 90s ──]  ← overlaps with exec N
```

1. **Executor** — executes blocks, accumulates overlay. RO tx. CPU-bound.
2. **Critical flusher** — state writes + trie. RW tx. ~61s.
3. **Background indexer** — changesets, keyIDs, histIdx, txIdx, logIdx, receipts, blockHashIdx. Separate RW tx. ~90s. Runs concurrently with executor (RO + RW coexist fine in MDBX).

Effective batch time: exec(2m) + critical_flush(61s) ≈ 3m for 10K = ~55 blk/s theoretical.

## What MUST be in the critical path (single-threaded, unavoidable)

- **State writes** (~10s): flat latest-block state (accounts + storage). Needed for EVM execution of the next batch.
- **Trie computation** (~51s): incremental state root. Required for block verification.

## What CAN be deferred to background

- **txIdx** (55s): tx hash → block/index lookup. Pure append, no dependency on state.
- **logIdx** (16s): address/topic → block bitmap. Pure append.
- **histIdx** (36s): keyID → block bitmap for historical state reconstruction. Pure append.
- **changesets** (22s): (keyID, oldValue) pairs. Captured during execution, written later. Needed for historical eth_call but NOT for forward execution.
- **receipts** (0.7s): log data per block. Pure append.
- **keyID assignment**: maps (address, slot) → compact ID. Needs read access but new IDs can be assigned in the background RW tx.
- **blockHashIdx**: block hash → block number. Trivial.

## Crash consistency

We don't need crash-safety (happy to lose minutes of data), but need crash-consistency:
- Core state (state + trie) is atomically committed in the critical RW tx.
- If we crash, deferred indexes may be behind. On restart, we detect the gap and re-index from the last committed index position.
- Changesets capture oldValues during execution (in memory), so they're always available to write even if deferred.

## DB Options Evaluated

### Option 1: Two MDBX environments (RECOMMENDED)
- Critical DB: state, hashed state, trie nodes
- Index DB: txIdx, logIdx, histIdx, changesets, receipts, blockHashIdx, keyDict
- Two envs = two concurrent RW txs. Same API, same cursor patterns.
- Minimal code change. No new dependencies.

### Option 2: Pebble (LSM) for indexes
- Great write throughput (memtable + sorted SSTables + zstd compression)
- But: indexes do read-modify-write (merge bitmaps). LSM read-before-write is costlier than B-tree.
- Adds a dependency. Different read patterns.
- Worth it only if two-MDBX isn't enough.

### Option 3: Bolt/bbolt for indexes
- Same B+tree model as MDBX but slower. No benefit. Skip.

### Option 4: Raw append-only files per key
- Millions of tiny files = filesystem nightmare. Skip.

### Option 5: Append-only WAL + compaction
- Reimplementing an LSM. Use Pebble instead. Skip.

### Option 6: ClickHouse / DuckDB
- Overkill for an embedded block syncer. Skip.

## Decision

Start with two MDBX environments. If index writes are still the bottleneck after pipelining, swap index DB to Pebble.
