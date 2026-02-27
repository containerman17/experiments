# Progress Checkpoint

## Current Architecture
- Flattened project layout to repo root (`go run .` from `/home/ubuntu/experiments/2026-02/02_repricing`).
- Hardcoded RPC endpoint for this case: `ws://127.0.0.1:9650/ext/bc/C/ws`.
- Shared websocket pool with 32 connections and round-robin request dispatch.
- Parallel block replay workers (`replayBlockWorkers = 8`) to allow concurrent RPC activity.
- Strict mode:
  - no block/state cache reads or writes used by replay path
  - no receipt fallback path
  - state/RPC failures fail immediately

## Repricing
- Repricing hooks active in patched `libevm`:
  - `SSTORE` set path (`clean 0 -> non-zero`)
  - `CREATE2` base gas path
- Flags:
  - `-sstore-set-mult`
  - `-create2-mult`

## Output Redesign (implemented)
Per block output now includes:
- emoji health verdict (`🟢`, `🟡`, `🔴`)
- tx totals / compared / skipped
- status changes split by direction:
  - `✅->❌` (success to revert)
  - `❌->✅` (revert to success)
- logs changed count
- gas mismatches
- average gas delta (`avgΔ`) across compared txs
- average positive gas delta (`avg+Δ`) for txs with increase only
- apply errors, log-compare errors, RPC calls, elapsed

Global summary now includes:
- total status changes + directional split
- total logs changed
- average gas delta and average gas increase

Per-tx JSONL rows now include:
- status/gas fields
- strict log compare fields:
  - `logs_changed`
  - `logs_diff_reason`
  - `log_compare_error` (if canonical log decode/compare fails)

## Log Comparison Rule
Receipt logs are compared strictly and in order by:
- address
- topics array
- data bytes

A single-byte/topic/address/order/count mismatch marks `logs_changed=true`.

## Verification Status
- Build: `go build ./...` passes.
- Smoke run: `go run . -block 79115440 -profile progress_check` passes.
- Sample output shows new emoji block line + expanded summary metrics.

## Known Notes
- Unsupported Avalanche precompile txs can still be excluded from mismatch stats via `-skip-unsupported-precompiles`.
- `-profile` is labeling/output naming only; repricing is controlled by multiplier flags.
