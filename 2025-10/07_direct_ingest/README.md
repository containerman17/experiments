# Ethereum Block Fetcher with Batch API

High-performance Ethereum block data fetcher using JSON-RPC batch API for maximum throughput.

## Features

- **Batch API**: Groups multiple RPC calls into single HTTP requests, reducing network overhead
- **3-Phase Fetching**: Blocks → Receipts → Traces, all batched and concurrent
- **Configurable Batching**: Separate batch sizes for regular RPC and debug calls
- **Concurrent Execution**: Multiple batches executed in parallel with configurable limits
- **Strict Validation**: Dies on any inconsistency - no silent failures
- **Complete Data**: Captures all fields from blocks, transactions, receipts, and traces
- **Test Coverage**: Validates output against raw JSON-RPC requests (byte-for-byte equality)

## Architecture

### Batch Processing Flow

```
FetchBlockRange(from, to)
  ↓
Phase 1: Fetch all blocks (batched)
  - Split block range into batches of batchSize
  - Execute batches concurrently (limited by rpcConcurrency)
  - Extract all transaction hashes
  ↓
Phase 2: Fetch all receipts (batched)
  - Group all tx hashes into batches of batchSize
  - Execute batches concurrently (limited by rpcConcurrency)
  - Map receipts back to transactions
  ↓
Phase 3: Fetch all traces (batched, if enabled)
  - Try block-level traces first (batches of debugBatchSize)
  - Fall back to per-tx traces if block-level fails
  - Execute batches concurrently (limited by debugConcurrency)
```

### Performance Parameters

- **BatchSize**: Number of requests per batch (default: 100)
  - Higher = fewer HTTP requests, but larger payloads
  - Tune based on node capacity and network latency
  
- **DebugBatchSize**: Number of debug requests per batch (default: 10)
  - Debug calls are heavy, use smaller batches
  
- **RpcConcurrency**: Concurrent batch requests (default: 10)
  - Controls how many batches run simultaneously
  - This is ABOVE the batch size (multiplies throughput)
  
- **DebugConcurrency**: Concurrent debug batch requests (default: 2)
  - Conservative default for heavy debug operations

## Error Handling

The fetcher uses strict error handling:
- **All RPC errors are fatal** - no silent failures
- **Validates batch response IDs** - ensures responses match requests
- **Checks for null/missing data** - catches incomplete responses
- **Verifies response counts** - batch responses must match request count

This ensures data integrity at the cost of failing fast on any issue.

## Data Structures

### NormalizedBlock
```go
type NormalizedBlock struct {
    Block    Block                 // Full block with transactions
    Traces   []TraceResultOptional // Traces for each transaction
    Receipts json.RawMessage       // Raw JSON array of receipts
}
```

All fields use `json.RawMessage` where possible to avoid data loss from strict parsing.

