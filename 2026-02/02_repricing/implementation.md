# Implementation Notes

## Intent (from discussion)
The replay tool is built for **counterfactual gas repricing analysis** with these priorities:

1. **Speed first**
- fast runs over block ranges
- high RPC throughput

2. **Strict correctness boundaries**
- no soft fallbacks for missing RPC methods/state
- fail fast on real infra/runtime errors

3. **Meaningful divergence signal only**
- gas deltas are expected under repricing and are informational
- what matters for “breakage” is:
  - transaction status divergence (success/revert)
  - receipt log divergence (address/topics/data/order)

4. **Operationally simple output**
- per-block health should be binary: green or red
- no ambiguous yellow state

## Final Health Policy
Per block:
- `🟢` = status unchanged and logs unchanged
- `🔴` = any status change OR any log change

Gas mismatch does **not** affect color.

## High-Level Architecture

### 1) Replay engine
- Replays canonical transactions in canonical order within each block.
- Uses `libevm` message execution (`core.ApplyMessage`) with a layered state implementation.
- Uses C-Chain-like chain rules config (all relevant forks active).

### 2) State model
- `ReplayState` has layered semantics for EIP-2200 correctness:
  - base state from RPC at parent block
  - committed writes from prior txs in block
  - in-flight tx layer
- `GetState` and `GetCommittedState` are separated correctly.

### 3) Repricing hooks
- Patched local `libevm` fork (via `replace` in `go.mod`).
- Repriced gas paths:
  - SSTORE set path (`clean 0 -> non-zero`)
  - CREATE2 base gas
- Controlled by flags:
  - `-sstore-set-mult`
  - `-create2-mult`

## RPC / Performance Design

### Hardcoded endpoint
- RPC is hardcoded to:
  - `ws://127.0.0.1:9650/ext/bc/C/ws`

### Parallelism
- Shared websocket pool with **32 connections**, round-robin dispatch.
- Block replay runs in parallel workers (`replayBlockWorkers = 8`).

### Caching
- Replay path currently runs without practical cache use:
  - no block cache read/write in decision path
  - no state fallback logic

## Comparison Semantics

Per compared tx:

1. **Status**
- canonical receipt `status` vs replay result failed/success
- tracked with direction:
  - `✅->❌`
  - `❌->✅`

2. **Gas**
- `canon gasUsed` vs replay used gas
- tracked for analytics only (mismatch counts and averages)

3. **Logs (strict)**
- canonical receipt logs are compared to replay logs by:
  - count and order
  - log address
  - topics length and each topic value
  - data bytes
- any difference marks log divergence

## Error Handling Policy

### Fatal immediately
- block fetch/parse mismatch
- transaction message construction error
- unexpected `ApplyMessage` errors
- log decode/compare parse failures

### Expected divergence handling
- `core.ErrGasLimitReached` is treated as a **counterfactual outcome**, not infra failure:
  - block is marked with gas-limit hit tx index
  - remaining txs in block are marked `not executed: block gas limit reached`
  - run continues to next block

## Output Format

### Per-block line
- concise status line with green/red health and key counters
- gas shown as repricing analytics, not health signal

### Summary
- total compared/changed counts
- status direction split
- logs changed count
- gas mismatch analytics
- number of txs not executed due to block gas limit

### JSONL row output
- one row per tx with canonical/replay fields
- includes log-diff reason and execution metadata
- includes explicit rows for not-executed tail txs after block gas limit reached

## Project Layout (refactored)
Tool is flattened at repo root (no `cmd/replay` wrapper):

- `main.go`
- `rpc.go`
- `state.go`
- `debug.go`
- `ws_client.go`
- `go.mod`, `go.sum`
- `libevm_patched/`

## Typical Run

```bash
cd /home/ubuntu/experiments/2026-02/02_repricing

go run . -from 79115440 -to 79115500 -profile sstore_1p1 -sstore-set-mult 1.1 -create2-mult 1
```

## Notes
- `-profile` is a label for output files/rows.
- Repricing behavior is controlled only by multiplier flags.
- Green does not mean gas-identical; it means execution behavior (status/logs) remained equivalent.
