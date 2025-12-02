# EVM Sink

High-throughput EVM blockchain data ingestion service. Pulls blocks, receipts, and traces from RPC nodes, stores locally, compacts to S3, and streams to consumers over TCP.

## Quick Start

```bash
# Build
go build -o sink ./cmd/sink

# Run
./sink --config config.yaml
```

## How It Works

```
RPC Nodes → [Ingestion] → PebbleDB → [Compaction] → S3
                              ↓
                         TCP Server → Consumers
```

1. **Ingestion**: Fetches blocks with receipts and traces from RPC, saves to PebbleDB
2. **Compaction**: Background process compacts old blocks (100 at a time) to S3 as `.jsonl.zstd`
3. **Serving**: Streams blocks to consumers - from PebbleDB if recent, S3 if old

## Configuration

```yaml
pebble_path: ./data/pebble
listen_addr: ":9090"

# S3-compatible storage (AWS S3, Cloudflare R2, MinIO)
s3_bucket: my-bucket
s3_region: auto
s3_endpoint: https://xxx.r2.cloudflarestorage.com  # optional for R2/MinIO
s3_access_key: ""  # or use AWS_ACCESS_KEY_ID env var
s3_secret_key: ""  # or use AWS_SECRET_ACCESS_KEY env var
s3_prefix: v1

chains:
  - chain_id: 1
    name: ethereum
    rpcs:
      - url: http://eth-node:8545
        max_parallelism: 50  # the only tuning knob
```

## Consumer Client

```go
import "evm-sink/client"

// List available chains
chains, _ := client.GetChains(ctx, "localhost:9090")

// Stream blocks
c := client.NewClient("localhost:9090", 1) // chain_id = 1
blocks, errs := c.StreamBlocks(ctx, 12345) // from block 12345

for block := range blocks {
    fmt.Printf("Block %d\n", block.BlockNumber)
    // block.Data is json.RawMessage containing NormalizedBlock
}
```

## Protocol

TCP with newline-delimited JSON.

**List chains:**
```
→ {"type":"list_chains"}
← {"type":"chains","chains":[{"chain_id":1,"name":"ethereum","latest_block":19000000}]}
```

**Stream blocks:**
```
→ {"chain_id":1,"from_block":12345}
← {"type":"block","chain_id":1,"block_number":12345,"data":{...}}
← {"type":"block","chain_id":1,"block_number":12346,"data":{...}}
...
← {"type":"status","status":"live","head_block":19000000}  // caught up
← {"type":"block","chain_id":1,"block_number":19000001,"data":{...}}  // live blocks
```

## Storage

**PebbleDB (hot):** Recent blocks, key = `block:{chainID}:{blockNum:020d}`

**S3 (cold):** Historical blocks in 100-block batches
- Path: `{prefix}/{chainID}/{start:020d}-{end:020d}.jsonl.zstd`
- Format: Newline-delimited JSON, zstd compressed

## Adaptive Rate Limiting

The `max_parallelism` setting is the only knob. The system automatically:
- Backs off on errors (halves parallelism)
- Reduces parallelism if latency exceeds 2s
- Increases parallelism when latency is good (<840ms)

Target: 80-90% RPC utilization without overloading.

## Block Data Format

Each block is stored as a `NormalizedBlock`:

```go
type NormalizedBlock struct {
    Block    Block                 `json:"block"`
    Receipts []Receipt             `json:"receipts"`
    Traces   []TraceResultOptional `json:"traces"`
}
```

Traces use `debug_traceBlockByNumber` with `callTracer`.
