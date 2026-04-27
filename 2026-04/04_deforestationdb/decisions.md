# Decisions

Append-only architecture decision records. Never delete entries — supersede
by adding a new one with `(supersedes YYYY-MM-DD)` in the title. Oldest
first; tail of file is the latest.

---

## 2026-04-27 — TxNum-keyed log index, not BlockNum

**Decision**: Posting lists in `LogAddrIdx` and `LogTopicIdx` map to
TxNum, not BlockNum.

**Context**: Receipts are stored per-tx (`R/txNum`), matching Erigon E3's
ReceiptDomain. Block-keyed log indexes would force read-amplification on
every hit: read all receipts in the block (avg 100-500 txs), then
in-memory scan. TxNum-keyed gives direct fetch with one decode per hit.

**Alternatives considered**:
- **BlockNum-keyed** — smaller index, but read-amp on every hit. Wins
  only if receipts are stored per-block (Erigon historically did this;
  E3 moved away).
- **(BlockNum, logIdx-in-block)** — finer than block, coarser than tx.
  No real win over TxNum since receipts have ~1-5 logs each.

**Consequences**: Index size ~1.5-2× larger than block-keyed (most
topics appear in ≤1 tx per block, so the multiplier isn't N×). Aligns
with sender/body/receipt addressing — all four indexes share the same
dense integer space, EF compresses uniformly downstream.

**Source**: Erigon E3 — `db/state/statecfg/state_schema.go:332-345`,
`execution/stagedsync/stage_custom_trace.go:385-386`,
`rpc/jsonrpc/eth_receipts.go:433`. Verified 2026-04-27.

---

## 2026-04-27 — Position-agnostic single topic index

**Decision**: One `LogTopicIdx` over all topic positions (0-3), not four
position-specific indexes. Position is resolved at receipt-read time.

**Context**: An `eth_getLogs` query like `topic0=Transfer AND
topic2=recipientX` doesn't need positional knowledge to find candidates
— "block contains both values somewhere" is enough. Once we've narrowed
to candidate txs, position-checking on the actual receipt is microseconds.

**Alternatives considered**:
- **Per-position indexes (LogTopic0Idx, LogTopic1Idx, ...)** — 4× index
  storage, complicates the indexer, no real query speed-up because
  position resolution is cheap on a tight candidate set.
- **No topic index, bloom-only (reth model)** — collapses to O(range_size)
  scans, useless at archive scale (see decision 4 implicitly, and bloom
  saturation note in `log/2026-04-27.md`).

**Consequences**: Simpler indexer, smaller storage, query path needs to
verify positions when reading receipts (one byte-compare per topic per
log, negligible). For ERC20-style queries, the same address may appear
under both `LogAddrIdx[addr]` and `LogTopicIdx[0x000…000+addr]` — that's
the storage tax of position-agnostic design. Acceptable.

**Source**: Erigon — same files as decision above.
`for _, topic := range lg.Topics { IndexAdd(kv.LogTopicIdx, topic[:],
txTask.TxNum) }` confirms all positions feed the same index.

---

## 2026-04-27 — Force single-DB for subnet-evm chains

**Decision**: Set `UseStandaloneDatabase=false` in subnet-evm chain
config so that ProposerVM + inner VM share one Pebble env per chain.
C-Chain (coreth) is single-DB by default — no action.

**Context**: Subnet-evm defaults `UseStandaloneDatabase=true` for new
chains (it auto-detects empty `acceptedDB` and opens its own DB at
`chainDataDir/db/...`). Result: blocks/state in one DB, ProposerVM in
another, with no shared transaction. Coordinating commits across two
unrelated DB envs is a problem we don't need.

**Alternatives considered**:
- **Default (standalone)** — leaves us with two DB envs per chain.
  Per-chain commit coordination becomes our problem. No upside.
- **Patch avalanchego to know about the standalone-DB choice** — wrong
  layer; this is purely a subnet-evm concern, no upstream patch needed.

**Consequences**: One Pebble env per chain. ProposerVM lives under
prefix `proposervm/`, inner VM under `ethdb/`, accepted/metadata/warp/
validators each under their prefixes. We own the env; we control the
commit. Configuration burden: one flag per subnet-evm chain we run.

**Source**: `subnet-evm/plugin/evm/vm_database.go:55-96` (standalone
logic), `subnet-evm/plugin/evm/config/config.go:187` (config field),
`avalanchego/vms/proposervm/vm.go:64,153,173-176` (ProposerVM always
uses avalanchego's DB and passes the same DB to inner VM). Verified
2026-04-27.

---

## 2026-04-27 — Pebble-first, Firewood-second commit ordering

**Decision**: Each block's per-block batch commits to Pebble first
(synchronously), then Firewood. Recovery via Firewood's propose/commit
hook detects mid-flight crashes.

**Context**: Initially considered Firewood-first / Pebble-second to keep
state ahead of indexes. On inspection that breaks re-execution: re-exec
needs Firewood at the **pre-state** root, not post-state. Pebble-first
preserves re-executability and gives us idempotent index writes (dict
get-or-create, roaring `.Add`, deterministic LZ4 blob), so if we crash
between Pebble and Firewood, we replay the block, Firewood catches up,
no harm.

**Alternatives considered**:
- **Firewood-first** — breaks re-execution; we'd need a second source
  of pre-state to re-run a block. Adds complexity for no win.
- **Both atomic** — not possible without a coordinating WAL across two
  storage engines, which is exactly the layer we don't want to own.

**Consequences**: Asymmetric crash behaviour. Pebble-ahead is bounded
waste (one block's writes that Firewood will re-derive on replay).
Firewood-ahead would be fatal (no way to reconstruct the indexes). The
asymmetry justifies the strict ordering. Pebble's WAL doubles as ours
— no separate WAL layer to write.

**Source**: Will verify Firewood `Commit()` durability semantics
(sync-on-return vs lazy) before locking the implementation. Tracked as
open question in `plan.md`.

---

## 2026-04-27 — Per-block Pebble fsync as the Firewood durability primitive

**Decision**: Use `pebble.Apply(batch, Sync=true)` on every block. Do
NOT patch Firewood. Do NOT enable RootStore. Do NOT batch Pebble
fsyncs. Rely on causal ordering (Pebble fsync → Firewood.Commit) to
guarantee Firewood-on-disk is never strictly ahead of Pebble-on-disk.

**Context**: Firewood's main nodestore is never fsynced — only `pwrite`
goes through, with eventual OS flush. Its own `lib.rs:22-24` documents
"OS-level crash recovery, but not machine-level." There is no public
`Persist()` / `Flush()` API in either FFI variant. RootStore is a
lookup cache, not a durability barrier (its internal comment at
`storage/src/root_store.rs:101-102` explicitly disclaims OS-crash
safety). The user's hard constraint is: Firewood-ahead-of-Pebble is
unrecoverable. Three parallel investigations on 2026-04-27 closed the
design space.

**Alternatives considered**:
- **A — Patch Firewood to expose `Persist()` + nodestore fsync.** Lets
  us batch fsyncs every N blocks. ~3-4 wk upstream cost. Unnecessary
  given Option B works without it. Revisit only if Pebble fsync
  benchmarks badly.
- **C — Enable RootStore and treat its fsync as a barrier.** Verified
  unsafe: RootStore fsyncs only metadata pointers, with no ordering
  barrier on the underlying node writes. A crash can leave RootStore
  pointing to a revision whose node data is still in OS page cache.
  Rejected.
- **Naive "fsync every N blocks on both sides".** Original sketch.
  Doesn't apply because Firewood has no fsync hook on its nodestore.

**Consequences**:
- Per-block Pebble fsync cost: 50µs-1ms on commodity NVMe →
  ~1-23 hours total over 82M blocks for full sync. Pebble's automatic
  group-commit amortizes concurrent fsyncs (8-100× speedup), making
  effective cost sub-millisecond at typical concurrency.
- Steady-state at 1 block/sec is trivial.
- Recovery on restart: re-execute blocks from
  `min(deforestationHead, firewoodWatermark) + 1` up to
  `deforestationHead`. Idempotent — safe to repeat.
- "Firewood-ahead" disaster row in the failure-mode table becomes
  *impossible by construction* under this protocol.
- We accept that Firewood's on-disk state may lag Pebble's by 1+
  blocks at any instant. That's fine — bounded waste, replayable.
- Production (avalanchego/coreth) takes a weaker version of this
  approach (no per-block Sync, accepts residual asymmetry risk). We
  go stricter because the archive use case demands it.

**Source**:
- `ideas/firewood-deforestation-commit-coordination.md` — full
  analysis, causal-ordering safety argument, failure-mode table,
  recovery procedure.
- `wiki/firewood-persistence-behaviour.md` — verified Firewood
  internals; RootStore-unsafe finding with citations.
- `wiki/firewood-production-usage.md` — how coreth/avalanchego use
  Firewood today; why our stricter approach is justified.

---

## 2026-04-27 — Reopen storage-dedup question (supersedes "Force single-DB for subnet-evm chains")

**Decision**: The earlier 2026-04-27 entry "Force single-DB for
subnet-evm chains" was framed around the wrong goal. The actual goal
is **storage deduplication of inner-block bytes between ProposerVM and
the inner VM**. Single-DB alone does NOT achieve this — both layers
still write the inner block bytes (once inside the ProposerVM
container, once in the inner VM's chaindb), just to the same physical
store. The means are now open and tracked as
`ideas/proposervm-inner-dedup.md` (to be authored).

**Context**: While reviewing hardware specs (2 TB target), the user
flagged that single-DB was treated as decided too quickly. Whether to
pursue single-DB at all depends on which dedup mechanism we choose;
some paths (e.g., ProposerVM-references-inner-VM-blocks) make the
single-DB question moot.

**Alternatives considered (now open, not decided)**:
- **Single-DB + accept duplication**: simplest, but doubles block-bytes
  storage. Per-chain `UseStandaloneDatabase=false` config.
- **ProposerVM-references-inner**: ProposerVM stores only ~144 B
  extras; inner block bytes fetched from inner VM at read time.
  Saves multi-TB. Requires hosting ProposerVM in-process or patching
  avalanchego.
- **Third option (user-mentioned, conversation cut off)**: TBD.

**Consequences**:
- The earlier "Force single-DB" entry is **superseded**, not deleted.
  Convention: append-only; readers see the evolution.
- The single-DB config flag may still be useful as a tactic regardless
  of the final dedup mechanism — kept on the table.
- No commitment yet on which path to take. Outcome may depend on
  harness-shape decision (`current.md`) since "ProposerVM hosted
  in-process" is far easier under the separate-executor harness.

**Source**: This conversation. Detailed analysis pending in
`ideas/proposervm-inner-dedup.md` (next session).
