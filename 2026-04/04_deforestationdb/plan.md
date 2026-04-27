# Plan — 04_deforestationdb

_Last updated: 2026-04-27_

## What we're building

A compact, verifiable archive node for Avalanche C-Chain and subnets.
Storage is period-partitioned (~100M tx per period). Distribution is
via BitTorrent. Hot tier is Pebble; tip state is Firewood; cold tier
is per-period compressed blob files with per-stream indexes. Reuses
Erigon, avalanchego, coreth, libevm, firewood code maximally —
implements interfaces, not re-implements logic.

**Target hardware**: 2 TB disk (NVMe or EBS — both supported), 32 GB
RAM. Single-machine; no clustering.

Key constraint: each upstream patch to avalanchego/coreth = at least one
month of PR + calls. Minimize patches. Prefer plug-in points (config
flags, ChainVM interface, AppRequest/AppResponse channels).

## Architecture sketch

### Hot tier (Pebble, single env)

Single-byte numerical prefixes (no string prefixes — keep keys tight):

| Prefix | Key suffix | Value | Purpose |
|---|---|---|---|
| `0x00` | `blockNum(8 BE)` | RLP(header) | block headers |
| `0x01` | `blockNum(8 BE)` | `firstTxNum(8) + txCount(4)` | block → tx range |
| `0x02` | `txNum(8 BE)` | RLP(tx body) | tx by global txnum |
| `0x03` | `txNum(8 BE)` | RLP(receipt) | receipt by txnum |
| `0x04` | `txNum(8 BE)` | sender(20) | derived at exec, stored |
| `0x05` | `txHash[:8]` | txNum(8) | tx-hash → txnum (verify full hash on read via 0x02) |
| `0x06` | `addr(20) + blockNum(8 BE)` | roaring(txNum positions) | log addr index |
| `0x07` | `topic(32) + blockNum(8 BE)` | roaring(txNum positions) | log topic index, position-agnostic |
| `0x08` | `blockNum(8 BE)` | LZ4(changeset blob) | pre-image for historical state reads |
| `0x09` | static | watermarks, txnum allocator, period state | metadata |

Range left for future use: `0x0a..0xff`.

### Tip state (Firewood)

- 128-revision in-memory sliding window handles eth_call-at-latest race naturally.
- Not tip-only as I initially thought — has revision API.
- We commit Pebble first, Firewood second (asymmetry: Pebble-ahead = bounded waste, Firewood-ahead = fatal).

### Cold tier (per-period files, ~100M tx each)

Per period:
- `bodies.dat` + `receipts.dat` — seekable-zstd, frame-per-block.
- `proposervm_extras.dat` — ~144 B/block; we reconstruct full container on demand via codec.Marshal.
- `senders.dat` — fixed-offset 20B array (offset = txNum × 20).
- `headers.dat` — sstable with sparse index, or MPH+EF-offsets.
- `tx_hash.idx` — MPH + fingerprint (or sstable on sorted hash).
- `log_addr.ef` / `log_topic.ef` — EF-encoded posting lists, position-agnostic.
- `period.idx` — manifest.

Codec choice still open: columnar split + trained zstd vs Erigon-style
patricia+huffman vs reth-style stock LZ4-on-columns. AI-era multi-agent
design pass on per-blob-type structural decomposition is the proposed
path (see ideas/).

### Crash safety

Per-block `pebble.Apply(Sync=true)` + Firewood.Commit (no fsync).
Causal-ordering proof: Pebble durable through N before Firewood
nodestore writes for N hit OS cache → Firewood-on-disk never strictly
ahead of Pebble-on-disk. No upstream patches needed. Decided
2026-04-27 — see `decisions.md` "Per-block Pebble fsync as the
Firewood durability primitive."

### Storage deduplication between ProposerVM and inner VM (open)

**Goal**: avoid storing the same inner-block bytes twice (once inside
the ProposerVM container blob, once in the inner VM's chaindb). This
goal subsumes the earlier "force single-DB" framing — single-DB alone
puts both layers in the same Pebble env but does NOT dedupe the inner
block bytes.

Approaches under consideration (none decided):
- **Single-DB + accept the duplication**: simplest; ProposerVM stores
  full container including inner block bytes, inner VM stores its own
  copy. Same physical store, double the block-bytes cost.
- **ProposerVM-references-inner**: ProposerVM stores only its
  extras (~144 B/block: ParentID, Timestamp, PChainHeight, Cert,
  signature) and reconstructs the container by pulling inner block
  bytes from the inner VM at read time. Saves multi-TB. Requires
  patching avalanchego ProposerVM or hosting it in-process under
  our own control.
- **Other**: TBD; user mentioned a third path that got cut off in the
  conversation.

This is now an `ideas/` exploration, not a settled decision. The earlier
2026-04-27 entry "Force single-DB for subnet-evm chains" is superseded
by a new decisions.md note clarifying the goal and reopening the means.

## Open questions (active)

1. **Harness shape** — fit into avalanchego or separate executor? See
   `current.md`. Outcome shapes everything that follows.
2. **Storage dedup ProposerVM↔inner VM** — single-DB-and-accept,
   ProposerVM-references-inner, or third option (see Architecture
   sketch). To be filed as `ideas/proposervm-inner-dedup.md`.
3. **Codec per blob type** — columnar split + trained zstd or Erigon's
   patricia+huffman seg format or hybrid. AI-era multi-agent design pass
   is the proposed approach.
4. **Subnet-evm `revision()` Go binding** — exposed already, or do we need
   to add a small FFI extension?
5. **Bootstrap discovery** — leaning toward static signed manifest at
   well-known URL + BitTorrent DHT + AppRequest/AppGossip via existing
   avalanchego mechanism. Zero upstream patches needed.

## What's next

1. Resolve harness question (`current.md`).
2. Based on harness outcome: stub the executor (or the avalanchego
   integration), write its first end-to-end test (sync block N, verify
   header.Root).
3. Then: hot-tier Pebble layout, working with one period's worth of mainnet data.
