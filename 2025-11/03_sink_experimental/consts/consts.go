// Package consts contains all tunable constants in one place
package consts

import "time"

// =============================================================================
// RPC Controller - Adaptive parallelism tuning
// =============================================================================

const (
	// RPCMetricsWindow is the sliding window for latency/error metrics
	RPCMetricsWindow = 60 * time.Second

	// RPCAdjustInterval is how often parallelism is adjusted
	RPCAdjustInterval = 1 * time.Second

	// RPCDefaultMaxParallelism if not specified in config
	RPCDefaultMaxParallelism = 200

	// RPCMaxLatency - default max P95 latency before reducing parallelism
	RPCMaxLatency = 1000 * time.Millisecond

	// RPCMaxErrorsPerMinute - halve parallelism if exceeded
	RPCMaxErrorsPerMinute = 10
)

// =============================================================================
// RPC Fetcher - Batch sizes and timeouts
// =============================================================================

const (
	// FetcherBatchSize for standard RPC calls (blocks, receipts)
	FetcherBatchSize = 50

	// FetcherDebugBatchSizeMax caps debug_trace* batch size
	FetcherDebugBatchSizeMax = 2

	// FetcherMaxRetries for failed RPC calls
	FetcherMaxRetries = 20

	// FetcherRetryDelay base delay between retries (exponential backoff)
	FetcherRetryDelay = 500 * time.Millisecond

	// FetcherHTTPTimeout for RPC requests
	FetcherHTTPTimeout = 30 * time.Second

	// FetcherMaxIdleConns for HTTP connection pool
	FetcherMaxIdleConns = 10000

	// FetcherIdleConnTimeout for HTTP keep-alive
	FetcherIdleConnTimeout = 90 * time.Second

	// FetcherDialTimeout for new connections
	FetcherDialTimeout = 30 * time.Second
)

// =============================================================================
// Storage - S3 and compaction
// =============================================================================

const (
	// StorageBatchSize is blocks per S3 file
	StorageBatchSize = 100

	// StorageMinBlocksBeforeCompaction keeps this many blocks in PebbleDB
	StorageMinBlocksBeforeCompaction = 1000

	// StorageCompactionInterval is how often to check for compaction
	StorageCompactionInterval = 3 * time.Second
)

// =============================================================================
// Server - WebSocket streaming
// =============================================================================

const (
	// ServerListenAddr is the HTTP/WebSocket server address
	ServerListenAddr = ":9090"

	// ServerS3Lookahead is number of S3 batches to prefetch
	ServerS3Lookahead = 200

	// ServerTipPollInterval when waiting for new blocks at tip
	ServerTipPollInterval = 50 * time.Millisecond
)
