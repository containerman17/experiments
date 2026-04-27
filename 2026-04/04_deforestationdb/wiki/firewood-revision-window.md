# Firewood revision sliding window

**System**: firewood (Ava Labs MPT state DB)
**Last verified**: 2026-04-27

## Summary

Firewood is **not** tip-only. It maintains an **in-memory sliding
window of past revisions**, defaulting to **128**. Any committed root
hash within this window can be opened as an immutable, read-only
`Revision` and queried via `Get` / iterators. Once a revision falls
outside the window (oldest revisions are evicted as new ones arrive),
it becomes inaccessible.

This is what makes `eth_call` at `latest` race-safe: the read holds a
revision handle that pins the state at a specific root, even as the
chain advances. The 128-revision default also means historical reads
within the last ~128 blocks are free without any overlay layer.

There is also an optional "deferred persistence" mode for retaining
revisions beyond `max_revisions`, but that's separate from the in-memory
window.

A Go FFI binding exists at `firewood/ffi/revision.go` exposing the
`Revision` type and the `fwd_get_from_revision` / `fwd_iter_on_revision`
C functions.

## Evidence

- `/home/ubuntu/firewood/firewood/src/manager.rs:42-43` — config:
  ```rust
  #[builder(default = 128)]
  max_revisions: usize,
  ```
- `/home/ubuntu/firewood/firewood/src/manager.rs:313-317` — eviction:
  ```rust
  // When we exceed max_revisions, remove the oldest revision from memory
  while in_memory_revisions.len() >= self.max_revisions {
      ...
  }
  ```
- `/home/ubuntu/firewood/firewood/src/manager.rs:120` — comment about
  `deferred_persistence_commit_count`: *"When present, enables retrieval
  of revisions beyond `max_revisions` by ..."* (separate optional path).
- `/home/ubuntu/firewood/firewood/src/manager.rs:341` —
  `firewood_gauge!(MAX_REVISIONS).set_integer(self.max_revisions)` —
  exposed as a metric.
- `/home/ubuntu/firewood/ffi/revision.go:34-67` — Go FFI: `Revision`
  type, doc comment confirms *"Revision is an immutable view over the
  state at a specific root hash"*. Methods include `Get`, drop semantics
  via `runtime.Pinner`.
- `/home/ubuntu/firewood/ffi/revision.go:6-17` — C bindings:
  `fwd_get_from_revision`, `fwd_iter_on_revision`,
  `fwd_reconstruct_on_revision`, `fwd_revision_dump`, `fwd_free_revision`.

## Implications

For the archive:
- Tip-state reads are free for the last ~128 blocks without any overlay.
  Most `eth_call(latest)` queries are fully serviced by Firewood alone.
- For older blocks, we still need our pre-image overlay
  (see `~/deforestationdb/` prototype). But the 128-block buffer means
  there's a comfortable runway before the overlay path matters.
- The Go binding `firewood/ffi/revision.go` is already wired — no FFI
  extension needed for revision-based reads. This was an open question;
  it's now closed.
- Race safety: hold a `Revision` for the duration of an RPC call; the
  state is pinned even as new blocks commit.
- We do NOT need to enable RootStore / archive mode just to handle the
  `eth_call(latest)` race — the default sliding window already does it.

## Caveats

- 128 is configurable; some setups may use higher (test code uses
  `100_000`). For production we'll need to pick a value that balances
  RAM (cost: ~192MB at 1.5M nodes × 128 bytes per the comment at
  `firewood/src/manager.rs:47`) against the size of the
  "free historical reads" window.
- A revision must be `Drop`ped before the database closes; FFI uses a
  finalizer as backup but it's not safe to rely on
  (`firewood/ffi/revision.go:36-43`).
