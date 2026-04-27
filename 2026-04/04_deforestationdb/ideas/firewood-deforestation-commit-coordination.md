# Firewood ↔ Deforestation commit coordination

**Status**: **decided 2026-04-27** — Option B (per-block Pebble fsync)
adopted. See `decisions.md` 2026-04-27 entry "Per-block Pebble fsync as
the Firewood durability primitive." This file remains for the analysis
and reasoning behind the choice.
**Date**: 2026-04-27

## Question

How do Firewood (MPT state) and Deforestation (Pebble-backed KV layer)
coordinate per-block writes so that:
1. Firewood-on-disk NEVER advances past Pebble-on-disk
   (any such state is unrecoverable — would require wiping Firewood).
2. We don't pay an unacceptable fsync cost.

## Section 1 — Per-block ordering (settled)

Per block, write Pebble first, then commit Firewood:

1. `pebble.Apply(batch, Sync=true)` for the Deforestation batch
   (header, tx bodies, receipts, log indexes, dict inserts, watermark).
   **This blocks until the WAL is fsynced.**
2. `firewood.Commit(newRoot)` — registers a new revision. In-memory
   proposal; Firewood's background persist worker writes to disk
   asynchronously (no fsync, see
   `wiki/firewood-persistence-behaviour.md`).

Why this order: pebble-ahead = bounded waste (replay missing blocks on
restart, idempotent writes). Firewood-ahead = fatal. Asymmetry forces
the order. Matches `decisions.md` 2026-04-27.

## Section 2 — Why per-block Pebble fsync is the right primitive

The earlier "fsync every N blocks" idea didn't work because Firewood
doesn't expose any fsync hook on its main nodestore — its background
persist worker writes via `pwrite` and relies on OS flush. Three
verification studies on 2026-04-27 settled the design space.

### Causal-ordering safety argument

Even though Firewood's nodestore writes are not fsynced, they are
**causally ordered** behind Pebble's fsync per block:

1. We call `pebble.Apply(batch, Sync=true)` — blocks until WAL fsync
   completes. Pebble durable through block N.
2. We call `firewood.Commit(N)` — creates an in-memory proposal. Only
   after this does Firewood's persist worker have anything to write
   for block N.
3. Firewood's `pwrite` for block N's nodes hits OS page cache **strictly
   after** Pebble's fsync for block N has returned.
4. OS may or may not flush Firewood's writes for block N. Either way,
   Pebble for block N is already durable.

Conclusion: **Pebble-on-disk ≥ Firewood-on-disk at every moment after
the first fsync.** Firewood-ahead is impossible under this protocol.

### Cost is hours, not weeks

The "weeks" worry was overstated. Verified numbers:

| Per-block fsync latency | 82M-block total |
|---|---|
| 50µs (NVMe idle) | ~1.1 hours |
| 100µs (NVMe ideal) | ~2.3 hours |
| 500µs (typical) | ~11 hours |
| 1ms (high load) | ~23 hours |

Pebble's WAL writer has **automatic group-commit**: concurrent
`Apply(Sync=true)` calls coalesce into a single fsync. With even modest
concurrency (e.g., separate goroutines for tx execution and commit),
effective per-block fsync is sub-millisecond. With per-period batching
(if we relaxed atomicity within a period), it could drop to seconds
total.

For steady-state operation (~1 block/sec live), 1 fsync/sec is trivial.

### Why not Option A (patch Firewood)?

Patching Firewood to expose `Persist()` + nodestore fsync would let us
batch fsyncs (e.g., every 1000 blocks) — saving ~10× the per-block
fsync overhead. But:
- Pebble's group-commit already amortizes fsync cost across concurrent
  writes; the savings from batching are smaller than they look.
- Patch cost is ~3-4 weeks of upstream review per the project constraint
  ("each upstream change ≈ 1 month").
- Option B works without the patch and is provably safe.

We can revisit Option A later if Pebble fsync turns out to be a real
bottleneck in benchmarks. For now: ship Option B; measure; only patch
if measured cost demands it.

### Why not Option C (RootStore)?

Confirmed unsafe (`wiki/firewood-persistence-behaviour.md`). RootStore
is a lookup cache, not a durability mechanism. Its own internal comment
disclaims OS-crash safety. Reject.

## Section 3 — Failure modes under Option B

| Scenario | Pebble durable | Firewood durable | Recovery |
|---|---|---|---|
| Process kill mid-block-N | through N-1 (last fsynced) | through ≤N-1 | Re-execute from Firewood's recoverable point up to Pebble's; safe |
| OS crash mid-block-N | through N-1 | through ≤N-1 | Same as above; safe |
| OS crash during Pebble fsync of N | through N-1 (fsync didn't complete) | through ≤N-1 | Re-execute block N; safe |
| Power loss between Pebble.Apply return and Firewood.Commit | through N | through ≤N-1 | Re-execute block N; Firewood catches up; safe |
| **Firewood-ahead-of-Pebble** | — | — | **Impossible by construction** (causal argument above) |

The disaster row from earlier drafts is no longer a possible scenario.

### Recovery procedure

On startup:
1. Read Pebble watermark `M/deforestationHead` = N.
2. Open Firewood, get the latest recoverable revision root R, find its
   block height M (lookup via stored header or RootStore if enabled).
3. If M < N: re-execute blocks M+1..N against Firewood, verify roots
   match. Both layers caught up.
4. If M = N: clean state. Resume at N+1.
5. If M > N: **impossible**. If we somehow detect it, refuse to start
   and surface a hard error — but we shouldn't see it under Option B.

## Section 4 — RAM cost

- Firewood: 192 MB node cache by default
  (`firewood/src/manager.rs:47`). With `deferred_persistence_commit_count=1`
  (default), no significant deferred-write accumulation.
- Pebble: default memtable 64 MB, rotates on size. With per-block
  Sync=true, WAL doesn't accumulate beyond fsync — small footprint.

Total: under 1 GB. Acceptable on the 16-32 GB target hardware.

## Section 5 — Recommendation

**Adopt Option B.** Concretely:

- `pebble.Apply(batch, Sync=true)` per block. Leverage Pebble's
  automatic group-commit (free 8-100× speedup with concurrency).
- Firewood at `deferred_persistence_commit_count=1` (default).
  Do NOT enable RootStore (production doesn't either).
- Recovery: replay missing blocks from Firewood-watermark to
  Pebble-watermark on restart.
- Future: revisit a Firewood `Persist()` patch if benchmarks show
  Pebble fsync is a real bottleneck. For now, no patches.

This should harden into a `decisions.md` entry once we run the first
end-to-end test that confirms recovery works as specified.

## Open / verify-during-implementation

- Confirm Pebble's group-commit actually fires during our workload —
  expect concurrency from blockfetcher/executor split.
- Measure real per-block Pebble fsync latency on the target hardware
  during initial sync.
- Sanity-check the production-imported `firewood-go-ethhash/ffi`
  matches the local `firewood/ffi/` we read from. May differ in detail.
- Verify our recovery procedure with an injected-crash test before
  trusting it in production.

## Related

- `wiki/firewood-persistence-behaviour.md` — what Firewood actually
  does on disk; why RootStore is unsafe.
- `wiki/firewood-production-usage.md` — how coreth/avalanchego use
  Firewood (they accept residual risk; we don't have to).
- `wiki/firewood-revision-window.md` — sliding window mechanics.
- `decisions.md` 2026-04-27 — "Pebble-first, Firewood-second commit
  ordering" (still settled).
