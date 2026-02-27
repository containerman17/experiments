# Counterfactual Block Replay Plan (V2)

## Goal
For a target block range, replay canonical transactions in canonical order under modified opcode pricing and output:
- exact txs whose status changes (`success -> revert`, `revert -> success`)
- txs whose status is unchanged but behavior differs (gas/logs/output/state-diff)

This directly answers: "Which exact canonical txs would have changed under repricing?"

## Key Corrections Applied
- Sequential replay must preserve cross-tx writes in the block.
- `GetState` and `GetCommittedState` must use different layers for EIP-2200 correctness.
- Repricing cannot be done by runtime assignment to `params.*` constants; use patched gas schedule logic.
- Warm-cache runs can still have RPC misses if counterfactual execution touches new keys.

## Scope
- Use existing isolate architecture from `cmd/25_pure_function`.
- Keep existing snapshot format (`WriteSnapshot`/`ReadSnapshot`).
- Add replay-specific runner, state layer, block/receipt cache, and reporting.

## Non-Goals
- No consensus VM replacement.
- No mempool/live mode changes.
- No attempt to perfectly emulate miner ordering outside canonical block order.

## Inputs / Outputs
### Inputs
- `block_from`, `block_to`
- `trace_rpc_url` (for block + receipts)
- `state_rpc_url` (for lazy state loads; can be local node)
- repricing profile (e.g., `sstore_set_mult`, `create2_mult`)

### Outputs
- `cache/blocks/block_<N>.json` (block + receipts)
- `cache/prestate/prestate_<parent>.snap` (pre-block state cache)
- `out/replay_<profile>_<from>_<to>.jsonl` (per-tx results)
- `out/replay_<profile>_<from>_<to>_summary.json`

## Architecture
## 1) Block Cache
`LoadBlockCache(N)`:
- read `cache/blocks/block_<N>.json` if present
- else fetch:
  - `eth_getBlockByNumber(0xN, true)`
  - receipts via `eth_getBlockReceipts(0xN)` if supported, fallback to per-tx `eth_getTransactionReceipt`
- persist JSON

## 2) Pre-State Snapshot Cache
Replay of block `N` must start from parent state (`N-1`):
- load `cache/prestate/prestate_<N-1>.snap` if exists
- else start empty and lazy-fetch from RPC at block tag `N-1`
- after run, save merged fetched keys back to `prestate_<N-1>.snap`

Important: cache naming is by **parent block**, not by replayed block.

## 3) Replay State Layers
Implement `ReplayState` with these layers:
- `base`: snapshot + RPC fallback (existing `BenchmarkStateManager` behavior)
- `dirty`: committed writes from prior txs in same block
- `tx`: in-flight writes for current tx + journal/snapshot/revert

Read order:
- `GetState`: `tx -> dirty -> base`
- `GetCommittedState`: `dirty -> base` (never `tx`)

Write lifecycle:
- `BeginTx` => clear `tx` layer
- EVM executes and mutates `tx`
- `CommitTx` => merge `tx` into `dirty`
- `RollbackTx` => discard `tx` (if needed)

Also track accessed keys for storage/code/balance to improve next run cache coverage.

## 4) Transaction Execution Path
Prefer libevm state transition path over fully manual accounting:
- decode tx to `types.Transaction`
- build `Message` with `core.TransactionToMessage(...)`
- create EVM context from canonical header
- execute with `core.ApplyMessage(...)` + gas pool
- collect:
  - status (`res.Failed()`)
  - `UsedGas`
  - return/revert bytes
  - logs from state DB

This reduces consensus drift vs hand-written gas/nonce/refund logic.

## 5) Comparator
Per tx, compare replay result vs canonical receipt:
- `status_changed`
- `gas_used_delta`
- `log_count_delta`
- optional output hash diff

Record:
- `block_number`, `tx_index`, `tx_hash`
- canonical vs replay status/gas
- mismatch reason(s)

## 6) Repricing Injection
Do not mutate `params` constants at runtime.

Implement repricing in patched libevm gas schedule code:
- adjust `SSTORE` paths in gas metering logic (especially zero->nonzero path)
- adjust `CREATE2` cost path
- bind to profile values via:
  - compile-time profile, or
  - package-level config in forked libevm loaded before replay

Keep canonical profile as baseline for A/B runs.

## Implementation Plan
## Phase 1: Data + Cache
- Add `replay_block_cache.go`
  - block + receipts fetch/persist with fallback receipt strategy
- Add `replay_types.go`
  - typed block/receipt/replay result structs

## Phase 2: Replay State
- Add `replay_state.go`
  - `ReplayState` implementing `vm.StateDB`
  - layered `GetState`/`GetCommittedState`
  - tx begin/commit/rollback

## Phase 3: Executor
- Add `replay_exec.go`
  - `ReplayBlock(...)`
  - tx loop in canonical order
  - comparator + per-tx print/report rows

## Phase 4: Snapshot Persist
- Reuse existing snapshot format
- Save merged fetched prestate to `prestate_<N-1>.snap`

## Phase 5: CLI
- Add `cmd/replay/main.go` (or new mode in `25_pure_function/main.go`)
- flags: block range, RPC URLs, profile, output paths

## Suggested Core API
```go
type ReplayConfig struct {
    StateRPC   string
    TraceRPC   string
    CacheDir   string
    OutDir     string
    ChainCfg   *params.ChainConfig
    Profile    RepriceProfile
}

type RepriceProfile struct {
    Name              string
    SStoreSetMultiplier float64
    Create2Multiplier float64
}

func ReplayBlock(cfg ReplayConfig, blockNum uint64) (*BlockReplayResult, error)
```

## Reporting
Per block print:
- txs processed
- status changes count
- behavior changes count
- cache misses / RPC errors
- elapsed time

Final summary:
- total txs
- changed tx hashes
- top gas deltas
- blocks with highest divergence

## Validation Gates
1. Baseline gate: replay with canonical gas profile should match canonical status for all txs in test blocks.
2. Determinism gate: rerun same block/profile with warm cache, identical outputs.
3. Repricing gate: changed statuses are stable across reruns.

## Risks / Mitigations
- Risk: divergence from consensus rules in custom StateDB.
  - Mitigation: use `core.ApplyMessage`, keep tx context/header fields canonical.
- Risk: missing receipts API support.
  - Mitigation: fallback to per-tx receipt fetch.
- Risk: warm cache still misses on divergent control flow.
  - Mitigation: expected; persist newly fetched keys after each run.

## Definition of Done
- Can replay a block range with canonical profile and produce zero/near-zero unexpected mismatches.
- Can replay same range with repriced profile and emit exact changed tx list with hashes.
- State cache persists and materially reduces RPC calls on repeated runs.
