# Erigon vs reth — block/tx compression

**System**: erigon, reth
**Last verified**: 2026-04-27

## Summary

Erigon and reth take very different approaches to compressing block,
transaction, and receipt snapshot files:

- **Erigon**: row-oriented (full RLP transactions packed end-to-end),
  with a custom patricia-tree pattern dictionary + Huffman codec
  (`db/seg`). Dictionary is **trained per segment** by sampling the data
  and extracting frequent 8-128 byte patterns. Real-data ratio ~48% (74
  GB raw → ~35-39 GB compressed).
- **Reth**: columnar (per-field), with **stock LZ4** as default codec.
  Optional Zstd with optional per-column trained dictionary. Each segment
  (Headers, Transactions, Receipts, etc.) has 1-3 columns indexed
  independently via `nippy-jar`.

Neither aggressively combines columnar split *with* trained zstd. That
combination is the gap our archive can exploit
(see `ideas/codec-design-pass.md` once written).

## Evidence

### Erigon (custom seg)

- `/tmp/erigon/db/seg/compress.go:50-70` — comment table reporting
  experimental compression results on a real BSC blocks file:
  74 GB uncompressed → 35.8-39.6 GB depending on dict size; ~48% ratio.
- `/tmp/erigon/db/snapshotsync/freezeblocks/block_snapshots.go:609-618` —
  `BlockCompressCfg`: `MinPatternScore=1000`, `MinPatternLen=8`,
  `MaxPatternLen=128`, `SamplingFactor=4`, `MaxDictPatterns=16384`.
- `/tmp/erigon/execution/stagedsync/stage_custom_trace.go:385-391` —
  transactions packed as full-RLP "words" (row-oriented), confirmed by
  the dump path.
- The codec itself is patricia-tree pattern matching + Huffman codes
  (custom; not zstd, not lz4).

### Reth (nippy-jar)

- `/tmp/reth/crates/storage/nippy-jar/src/lib.rs:84-87` (doc comment) —
  *"`NippyJar` is a specialized storage format designed for immutable
  data. Data is organized into a columnar format, enabling column-based
  compression. Data retrieval entails consulting an offset list and
  fetching the data from file via `mmap`."*
- `/tmp/reth/crates/static-file/types/src/segment.rs:114` —
  `pub const fn config(&self) -> SegmentConfig { SegmentConfig {
  compression: Compression::Lz4 } }` — default compression is LZ4 across
  all segments.
- `/tmp/reth/crates/static-file/types/src/segment.rs:118-127` —
  `columns()` method: `Headers => 3`, `Transactions | Receipts |
  TransactionSenders | AccountChangeSets | StorageChangeSets => 1`.
  Most segments are single-column blobs even though the format supports
  multiple columns.
- `/tmp/reth/crates/storage/nippy-jar/src/compression/zstd.rs:27-54` —
  optional Zstd codec with optional per-column trained dictionary
  (`use_dict=true`). Off by default; opt-in.

## Implications

For the archive:
- Erigon's ~48% ratio with custom codec is the bar to beat. Reth ratios
  not published in source.
- Pure stock LZ4 (reth default) is the easy baseline; Erigon's custom
  patricia+huffman is the sophisticated baseline.
- Real opportunity: **columnar split + per-column trained zstd** —
  neither system combines them aggressively.
- For transactions specifically: split per-field (nonce / gas / to /
  value / sig / data) and apply trained-zstd per stream. Likely 20-40%
  improvement over Erigon's row-oriented approach; details TBD via a
  design pass with multi-agent benchmarking.

The codec choice is one of the open questions in `plan.md` — not yet a
locked decision.
