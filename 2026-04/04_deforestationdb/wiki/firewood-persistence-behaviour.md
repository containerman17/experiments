# Firewood persistence behaviour (between checkpoints)

**System**: firewood (Ava Labs MPT state DB)
**Last verified**: 2026-04-27

## Summary

When `deferred_persistence_commit_count > 1`, Firewood **writes nodes
progressively to disk** between checkpoints but **does not fsync the
main nodestore**. Durability of the main trie data depends on the OS
page-cache flush schedule, not on Firewood. The optional `RootStore`
(historical revision metadata) is the only path that calls fsync, and
it covers only revision-pointer metadata, not the underlying nodes.

There is **no public `Persist()` / `Flush()` API** in either the Rust
crate or the Go FFI. Persistence is auto-driven by the
`deferred_persistence_commit_count` threshold; the user cannot force a
checkpoint at a chosen moment.

This means:
- (B) progressive write + deferred fsync is the actual model. Not (A)
  pure RAM. Not (C) WAL-with-recovery.
- After process kill: data may or may not be durable depending on OS
  asynchronous flush — outside Firewood's control.
- After OS crash: only data fsynced via RootStore (if enabled) is
  guaranteed; main nodestore data is whatever the OS happened to flush
  before the crash.

## Evidence

- `/home/ubuntu/firewood/storage/src/nodestore/persist.rs:287-301` —
  `persist()` calls `flush_nodes()` then `header.flush_to()`, both of
  which use `FileBacked::write()`. No `sync_all()` / fsync.
- `/home/ubuntu/firewood/storage/src/linear/filebacked.rs:186-199` —
  `FileBacked::write()` issues a blocking `pwrite(2)` and returns. No
  fsync follows.
- `/home/ubuntu/firewood/storage/src/root_store.rs:99-103` — the
  optional RootStore calls `keyspace.persist(PersistMode::Buffer)`,
  which DOES trigger fsync. But this only fsyncs the
  block-number → root-hash metadata pointers, not the underlying
  trie nodes.
- `/home/ubuntu/firewood/firewood/src/persist_worker.rs:14-31, 160-170,
  323-355` — permit model: up to `commit_count` unpersisted revisions
  may exist. Once `commit_count / 2` is reached, the background thread
  wakes and persists. Caller blocks if permits exhausted.
- `/home/ubuntu/firewood/firewood/src/persist_worker.rs:539-555,
  568-579` — background loop calls `persist_to_disk()`, writes the
  **latest** committed revision's nodes to disk, advances header.
  Older intermediate revisions in the queue are discarded without
  persisting.
- `/home/ubuntu/firewood/firewood/src/manager.rs:344-349` — each commit
  calls `persist_worker.persist(committed)`. If permits exhausted,
  caller blocks until background thread releases.
- `/home/ubuntu/firewood/firewood/src/persist_worker.rs:558-562` —
  on clean shutdown via `close()`, a final `persist_to_disk()` runs.
- FFI: `/home/ubuntu/firewood/ffi/firewood.go:527` exposes
  `FlushBlockReplay()` (flushes buffered block-replay ops, NOT general
  DB persistence). `PersistWorker` is `pub(crate)` in Rust — no public
  `db::flush()` or `db::persist()` exists, in Rust or Go.

## Crash scenarios under verified behaviour

| Scenario | Disk state at recovery |
|---|---|
| **Process kill mid-window** (some unpersisted commits in flight) | OS page cache flushes asynchronously after kill. Some intermediate writes may end up on disk; not deterministic. Firewood reopens at "latest header it can read," which may be a partial or older state depending on flush interleaving. |
| **OS crash mid-window** | OS page cache lost. Disk holds whatever was fsynced. Without RootStore: only initial DB header. With RootStore: last fsynced revision pointer, plus whatever node data the OS happened to flush (potentially incomplete for that revision). |
| **Clean shutdown via `close()`** | Final `persist_to_disk()` runs, latest revision durably written (still no fsync on the main nodestore, but pwrite + clean close + OS flush on shutdown is reliable in practice). RootStore fsyncs metadata. |

## Firewood's own crash-safety statement

From `/home/ubuntu/firewood/firewood/src/lib.rs:22-24`:

> Firewood provides OS-level crash recovery, but not machine-level crash
> recovery. That is, if the firewood process crashes, the OS will flush
> the cache leave the system in a valid state. No protection is
> (currently) offered to handle machine failures.

From `/home/ubuntu/firewood/README.md:37`:

> Firewood guarantees recoverability by not referencing the new nodes
> in a new revision before they are flushed to disk, as well as
> carefully managing the free list during the creation and expiration
> of revisions.

"Flushed to disk" here means `pwrite` returned, NOT fsync. Internal
write ordering is enforced; durability against power loss is not.

## RootStore is NOT a durability mechanism

After deep investigation, RootStore is unsafe as a coordinated
checkpoint with an external KV store:

- It is a **lookup cache** mapping root-hash → revision-address, used
  for archival mode (retaining old revisions). Type docstring at
  `/home/ubuntu/firewood/storage/src/root_store.rs:4-7` confirms:
  *"used to store the address of roots by hash so they can be recreated
  later... used only when enabled at database open time."*
- Its `keyspace.persist(PersistMode::Buffer)` call has the explicit
  comment (`storage/src/root_store.rs:101-102`):
  *"Flush the keyspace to protect against application crashes, but not
  OS crashes"*.
- **No ordering barrier**: nodestore `pwrite`s and RootStore metadata
  writes are independent. RootStore's metadata fsync does NOT wait for
  prior nodestore writes to be durable. A crash can leave RootStore
  pointing to a revision whose underlying node data is only in OS page
  cache.
- **Recovery does not validate node integrity**: `with_root()` at
  `nodestore/mod.rs:171-199` verifies the merkle hash matches, but only
  if the node is readable. No per-node checksums for torn-write
  detection.

So enabling RootStore does NOT give us a coordinated checkpoint with
Pebble. Reject this path.

## Implications

For any external consumer that needs strict crash durability:
- **Do not rely on Firewood for durability of the main nodestore.**
- **Reducing `deferred_persistence_commit_count` to 1 does not add
  fsync** — it only writes more eagerly via `pwrite`.
- **No way to force fsync** short of process exit or upstream patching.
- **RootStore is not a fix** — it's a lookup cache, not a durability
  mechanism, and its own comment explicitly disclaims OS-crash safety.
- The right way to get durability around Firewood: pair it with an
  external durable layer (Pebble fsynced) and lean on the **causal
  ordering** of operations — write to Pebble (sync), then commit to
  Firewood. Firewood's writes for block N happen strictly after
  Pebble's fsync for block N, so Firewood-on-disk can never be
  strictly ahead of Pebble-on-disk.

See `wiki/firewood-production-usage.md` for how coreth/avalanchego
handle this in practice (spoiler: they accept residual asymmetry risk
without explicit fsync coordination), and
`ideas/firewood-deforestation-commit-coordination.md` for our chosen
approach.
