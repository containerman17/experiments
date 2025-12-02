# EVM Sink

High-throughput EVM blockchain data ingestion service. Pulls blocks, receipts, and traces from RPC nodes, stores locally, compacts to S3, and streams to consumers via HTTP + WebSocket with zstd-compressed frames.

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
     ↑                         ↓
  WebSocket              HTTP + WebSocket → Consumers
 (newHeads)              (zstd frames)
```

1. **Head Tracking**: WebSocket subscription to `newHeads` for instant block notifications
2. **Ingestion**: Sliding window fetcher pulls blocks with receipts and traces in parallel
3. **Compaction**: Background process compacts old blocks (100 at a time) to S3 as `.jsonl.zstd`
4. **Serving**: HTTP for chain listing, WebSocket for streaming zstd-compressed blocks

## Configuration

```yaml
pebble_path: ./data/pebble
lookahead: 200  # sliding window size for fetching

# S3-compatible storage (AWS S3, Cloudflare R2, MinIO)
s3_bucket: my-bucket
s3_region: auto
s3_endpoint: https://xxx.r2.cloudflarestorage.com  # optional for R2/MinIO
s3_access_key: ""  # or use AWS_ACCESS_KEY_ID env var
s3_secret_key: ""  # or use AWS_SECRET_ACCESS_KEY env var
s3_prefix: v1

chains:
  # Avalanche C-Chain
  - chain_id: 43114
    name: C-Chain
    rpcs:
      - url: http://avalanche-node:9650/ext/bc/C/rpc
        max_parallelism: 200

  # Avalanche L1 subnets - URL: /ext/bc/{blockchainID}/rpc
  - chain_id: 836
    name: BnryMainnet
    rpcs:
      - url: http://avalanche-node:9650/ext/bc/J3MYb3rDARLmB7FrRybinyjKqVTqmerbCr9bAXDatrSaHiLxQ/rpc
```

**Note**: For Avalanche, RPC URL path `/ext/bc/.../rpc` gets converted to `/ext/bc/.../ws` for WebSocket head tracking.

## Consumer Client

```go
import (
    "evm-sink/client"
    "evm-sink/rpc"
)

// List available chains (HTTP)
chains, _ := client.GetChains(ctx, "localhost:9090")

// Stream blocks (channel API, WebSocket)
c := client.NewClient("localhost:9090", 1) // chain_id = 1
blocks, errs := c.StreamBlocks(ctx, 12345) // from block 12345

for block := range blocks {
    fmt.Printf("Block %d with %d txs\n", block.Number, len(block.Data.Block.Transactions))
}

// Stream blocks (handler API with auto-reconnect)
c := client.NewClient("localhost:9090", 1, client.WithReconnect(true))
err := c.Stream(ctx, client.StreamConfig{FromBlock: 1}, func(blockNum uint64, block *rpc.NormalizedBlock) error {
    // block is fully parsed
    return nil
})
```

## Example Client

```bash
# Build example client
go build -o example-client ./cmd/example-client

# List chains (HTTP)
./example-client -addr localhost:9090

# Stream a chain (WebSocket)
./example-client -addr localhost:9090 -chain 43114 -from 1
```

## Protocol

**List chains (HTTP):**
```
GET /chains
← [{"chain_id":1,"name":"ethereum","latest_block":19000000}]
```

**Stream blocks (WebSocket):**
```
GET /ws?chain=1&from=12345  (upgrade to WebSocket)
← [BINARY] zstd(NormalizedBlock\nNormalizedBlock\n...)  // S3 batch, ~100 blocks
← [BINARY] zstd(NormalizedBlock\n)                      // live block
```

All WebSocket frames are binary with zstd-compressed JSONL. Historical data sends S3 batches as-is (~100 blocks per frame, excellent compression). Live blocks are compressed individually.

Client decompresses each frame, splits on `\n`, parses each line as `NormalizedBlock` JSON. Block number extracted from `block.number` field. First frame may contain blocks before `from` (due to S3 batch alignment) - client filters them out.

## Storage

**PebbleDB (hot):** Recent blocks, key = `block:{chainID}:{blockNum:020d}`

**S3 (cold):** Historical blocks in 100-block batches
- Path: `{prefix}/{chainID}/{start:020d}-{end:020d}.jsonl.zstd`
- Format: Newline-delimited JSON, zstd compressed

## Adaptive Rate Limiting

The `max_parallelism` setting is the only knob. The system automatically:
- Starts at min parallelism (10% of max) and climbs up
- Increases parallelism when P95 < 1.2s
- Reduces parallelism if P95 > 2s
- Halves parallelism on errors
- Adjusts every 2s based on 60s sliding window

Target: maximize throughput without overloading RPC node.

## Block Data Format

Each block is stored as a `NormalizedBlock`:

```go
type NormalizedBlock struct {
    Block      Block                 `json:"block"`
    Receipts   []Receipt             `json:"receipts"`
    Traces     []TraceResultOptional `json:"traces"`
    StateDiffs []StateDiffResult     `json:"stateDiffs"`
}
```

- **Traces**: `debug_traceBlockByNumber` with `callTracer`, fallback to per-tx
- **StateDiffs**: `debug_traceTransaction` with `prestateTracer` + `diffMode: true`

## Ingestion Progress

The sink logs progress every 5 seconds:
```
[Chain 43114 - C-Chain] block 50234567 | 142.3 blk/s avg | 1234 behind, eta 8s | p=50 p95=450ms
```

- `blk/s avg`: average since start
- `behind`: blocks remaining to sync
- `eta`: estimated time to catch up
- `p=50`: current parallelism level
- `p95=450ms`: P95 request latency
