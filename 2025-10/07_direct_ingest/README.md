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

## Usage

### Command Line

```bash
# Build
go build -o fetcher main.go

# Fetch last 100 blocks without traces
./fetcher -rpc http://localhost:9650/ext/bc/C/rpc -from 71035000 -to 71035100

# Fetch with traces
./fetcher -rpc http://localhost:9650/ext/bc/C/rpc -from 71035000 -to 71035100 -traces

# Tune performance
./fetcher \
  -rpc http://localhost:9650/ext/bc/C/rpc \
  -from 71035000 -to 71035100 \
  -batch 200 \
  -debug-batch 20 \
  -rpc-concurrency 20 \
  -debug-concurrency 4 \
  -traces \
  -output blocks.json
```

### Programmatic Usage

```go
package main

import (
    "ingest/pkg/rpc"
    "log"
)

func main() {
    fetcher := rpc.NewFetcher(rpc.FetcherOptions{
        RpcURL:           "http://localhost:9650/ext/bc/C/rpc",
        IncludeTraces:    true,
        BatchSize:        200,    // 200 requests per batch
        DebugBatchSize:   20,     // 20 debug requests per batch
        RpcConcurrency:   20,     // 20 concurrent batches
        DebugConcurrency: 4,      // 4 concurrent debug batches
    })

    // Fetch blocks 1000-2000
    blocks, err := fetcher.FetchBlockRange(1000, 2000)
    if err != nil {
        log.Fatal(err)
    }

    // blocks[i] contains NormalizedBlock with:
    // - Block: full block with all transactions
    // - Receipts: array of all receipts
    // - Traces: array of all traces (if enabled)
}
```

## Testing

Tests verify that batch API produces identical results to raw JSON-RPC requests:

```bash
# Run tests (requires running node)
RPC_URL=http://localhost:9650/ext/bc/C/rpc go test -v ./pkg/rpc/

# Tests validate:
# - Blocks match raw eth_getBlockByNumber calls
# - Receipts match raw eth_getTransactionReceipt calls  
# - Traces match raw debug_traceBlockByNumber/debug_traceTransaction calls
```

## Performance Example

Fetching 100 blocks with ~5000 transactions:

**Without Batching** (old approach):
- 100 block requests
- 5000 receipt requests
- 5000 trace requests
- **Total: ~10,100 HTTP requests**

**With Batching** (batchSize=100, rpcConcurrency=10):
- 1 block batch
- 50 receipt batches (5000/100)
- 500 trace batches (5000/10)
- **Total: ~551 HTTP requests** (18x reduction)
- Multiple batches run concurrently for additional speedup

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

## License

MIT

