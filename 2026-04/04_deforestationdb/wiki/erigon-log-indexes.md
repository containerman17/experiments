# Erigon log indexes (E3)

**System**: erigon (E3 / current)
**Last verified**: 2026-04-27

## Summary

Erigon's E3 design uses exactly two log indexes — `LogAddrIdx` and
`LogTopicIdx` — both mapping to **TxNum** (not BlockNum). The topic
index is **position-agnostic**: a single inverted index serves topic
positions 0-3. Position is resolved at receipt-read time, not at index
time. Receipts themselves are stored per-tx in the `ReceiptDomain`,
keyed by TxNum.

This is the model we should adopt for the archive node — it's
significantly more efficient than reth's bloom-only model
(see `wiki/ethereum-bloom-saturation.md`) and aligns with our planned
TxNum-keyed hot-tier layout.

## Evidence

- `/tmp/erigon/db/state/statecfg/state_schema.go:332-345` — schema
  definitions for `LogAddrIdx` and `LogTopicIdx`. Both are
  `InvIdxCfg` (inverted index) entries. No `LogTopic0Idx`,
  `LogTopic1Idx` etc. exist — confirmed only one topic index.
- `/tmp/erigon/execution/stagedsync/stage_custom_trace.go:385-391` —
  the indexer that writes log topics:
  ```go
  for _, lg := range result.Logs {
      for _, topic := range lg.Topics {
          if err := doms.IndexAdd(kv.LogTopicIdx, topic[:], txTask.TxNum); err != nil {
              return err
          }
      }
  }
  ```
  All four topic positions feed the same index keyed by `txTask.TxNum`.
- `/tmp/erigon/rpc/jsonrpc/eth_receipts.go:433` — query path uses
  `tx.IndexRange(kv.LogTopicIdx, topic.Bytes(), int(from), int(to), asc, kv.Unlim)`.
  Returns TxNums.
- `/tmp/erigon/db/rawdb/rawtemporaldb/accessors_receipt.go:32` —
  `ReceiptAsOf(tx kv.TemporalTx, txNum uint64)` — receipts addressed
  by TxNum, stored in `ReceiptDomain`.

## Implications

For our archive:
- Build one address index (`LA/`) and one topic index (`LT/`), both
  keyed by TxNum (or address-or-topic-value as the inverted-index key,
  with TxNum as the posting list value).
- Position-checking happens when reading the receipt — cheap, microseconds
  per log.
- Storage cost is modest: per-position indexes would 4× the topic index
  size for no real query speedup, since topic-value selectivity matters
  far more than position.
- Backed our 2026-04-27 decisions on TxNum-keyed indexes and
  position-agnostic topic indexing (`decisions.md`).

For ERC20-style queries (`Transfer(addr_from, addr_to, amount)`), the
same address may appear under both `LogAddrIdx[addr]` and
`LogTopicIdx[0x000…000+addr]`. Acceptable storage tax.
