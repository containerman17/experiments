# Ethereum logs bloom saturation on modern blocks

**System**: ethereum protocol (header logsBloom field), as implemented
in geth, libevm, erigon
**Last verified**: 2026-04-27

## Summary

Ethereum's per-block `logsBloom` is a fixed-size **2048-bit** filter
with **3 hash functions** per insert. It was sized for 2015-era blocks
(~50 logs each) at a target ~1% false-positive rate. On modern blocks
with 100-300 logs each (~5 bloom inserts per log: address + up to 4
topics), the filter inserts **500-1500 items**, far above optimal
capacity. Resulting FP rate: ~70%.

This is why bloom-only models (geth, reth) cap `eth_getLogs` ranges to
a few thousand blocks: at archive scale, bloom scans are O(range_size)
and ~70% of bloom hits are false positives, forcing receipt reads on
mostly-noise candidate blocks.

The bloom format is part of consensus (`Header.Bloom` is in the header
hash) and cannot be resized without a fork.

## Evidence

- `/tmp/geth/core/types/bloom9.go:34-42` — constants:
  ```go
  // BloomByteLength represents the number of bytes used in a header log bloom.
  BloomByteLength = 256
  // BloomBitLength represents the number of bits used in a header log bloom.
  BloomBitLength = 8 * BloomByteLength
  // Bloom represents a 2048 bit bloom filter.
  type Bloom [BloomByteLength]byte
  ```
- `/tmp/geth/core/types/bloom9.go:142-156` — `bloomValues()` uses 3 hash
  positions per insert. Each `(address, topic_i)` value gets hashed and
  3 bits set. Position-agnostic — same hash regardless of topic position.
- `/tmp/erigon/execution/types/bloom9.go` — Erigon uses the same
  algorithm (consensus rule, identical implementation).

## False-positive math

For a bloom filter with `m` bits, `k` hash functions, and `n` inserted
items, FP rate is approximately `(1 - e^(-kn/m))^k`.

With `m=2048, k=3`:

| n (inserts) | FP rate |
|-------------|---------|
| 50 (2015-era block) | ~0.34% |
| 500 (slow modern block) | ~22% |
| 1500 (busy modern block) | ~70% |
| 3000 (DEX-heavy block) | ~93% |

So on busy blocks the filter approaches "always says yes" — useless as
a pre-filter.

## Implications

For the archive:
- We **cannot** rely on per-block bloom as a primary index. It's fine
  for a bounded recent-blocks query (last few thousand blocks), useless
  for "events matching X since genesis."
- The bloom IS still in our stored headers (it's part of the consensus
  hash, we have to keep it). Use it only as an opportunistic pre-filter
  layered on top of the real indexes — verify a candidate block before
  reading its receipts.
- This is why Erigon (and our archive) needs an explicit log index. See
  `wiki/erigon-log-indexes.md`.
- Geth/reth limit `eth_getLogs` ranges precisely because of this. Our
  archive needs to support unbounded ranges, which forces the
  index-based approach.

## Caveats

- The exact crossover where bloom becomes useless depends on workload.
  For chains/subnets with low logs-per-block (private chains, low
  activity), bloom can be adequate. For C-Chain mainnet during heavy
  DeFi periods, it's essentially saturated.
- Position-agnostic property: the bloom can confirm "value V appeared
  somewhere in this block's logs" but not at which topic position.
  Same property as Erigon's `LogTopicIdx` — position resolution
  happens at receipt-read time either way.
