package syncer

import (
	"context"
	"fmt"
	"ingest/pkg/cache"
	"ingest/pkg/chwrapper"
	"ingest/pkg/rpc"
	"log"
	"sync"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"golang.org/x/sync/errgroup"
)

// Config holds configuration for ChainSyncer
type Config struct {
	ChainID          uint32
	RpcURL           string
	RpcConcurrency   int           // Optional, default 300
	DebugConcurrency int           // Optional, default 200
	FetchBatchSize   int           // Blocks per fetch, default 100
	BufferSize       int           // Max batches in channel, default 10
	FlushInterval    time.Duration // Default 1 second
	FlushBatchSize   int           // Max blocks per DB write, default 1000
	CHConn           driver.Conn   // ClickHouse connection
	Cache            cache.Cache   // Cache for RPC calls
}

// ChainSyncer manages blockchain sync for a single chain
type ChainSyncer struct {
	chainId        uint32
	fetcher        *rpc.Fetcher
	conn           driver.Conn
	blockChan      chan []*rpc.NormalizedBlock // Bounded channel for backpressure
	watermark      uint32                      // Current sync position
	fetchBatchSize int
	flushInterval  time.Duration
	flushBatchSize int

	// Max block numbers in each table (queried once at startup)
	maxBlockBlocks       uint32
	maxBlockTransactions uint32
	maxBlockTraces       uint32
	maxBlockLogs         uint32

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	// Progress tracking
	mu            sync.Mutex
	blocksFetched int64
	blocksWritten int64
	lastPrintTime time.Time
	startTime     time.Time
}

// NewChainSyncer creates a new chain syncer
func NewChainSyncer(cfg Config) (*ChainSyncer, error) {
	// Apply defaults
	if cfg.RpcConcurrency == 0 {
		cfg.RpcConcurrency = 300
	}
	if cfg.FetchBatchSize == 0 {
		cfg.FetchBatchSize = 100
	}
	if cfg.BufferSize == 0 {
		cfg.BufferSize = 20000
	}
	if cfg.FlushInterval == 0 {
		cfg.FlushInterval = 1 * time.Second
	}
	if cfg.FlushBatchSize == 0 {
		cfg.FlushBatchSize = 1000
	}
	if cfg.RpcConcurrency == 0 {
		cfg.RpcConcurrency = 200
	}
	if cfg.DebugConcurrency == 0 {
		cfg.DebugConcurrency = 200
	}

	// Create fetcher
	fetcher := rpc.NewFetcher(rpc.FetcherOptions{
		RpcURL:           cfg.RpcURL,
		RpcConcurrency:   cfg.RpcConcurrency,
		MaxRetries:       100,
		RetryDelay:       100 * time.Millisecond,
		DebugConcurrency: 200,
		BatchSize:        1,
		DebugBatchSize:   1,
		Cache:            cfg.Cache,
	})

	ctx, cancel := context.WithCancel(context.Background())

	return &ChainSyncer{
		chainId:        cfg.ChainID,
		fetcher:        fetcher,
		conn:           cfg.CHConn,
		blockChan:      make(chan []*rpc.NormalizedBlock, cfg.BufferSize),
		fetchBatchSize: cfg.FetchBatchSize,
		flushInterval:  cfg.FlushInterval,
		flushBatchSize: cfg.FlushBatchSize,
		ctx:            ctx,
		cancel:         cancel,
		lastPrintTime:  time.Now(),
		startTime:      time.Now(),
	}, nil
}

// Start begins syncing
func (cs *ChainSyncer) Start() error {
	log.Printf("[Chain %d] Starting syncer...", cs.chainId)

	// Get starting position
	startBlock, err := cs.getStartingBlock()
	if err != nil {
		return fmt.Errorf("failed to determine starting block: %w", err)
	}

	// Query max block for each table once at startup
	cs.maxBlockBlocks, err = chwrapper.GetLatestBlockForChain(cs.conn, "raw_blocks", cs.chainId)
	if err != nil {
		return fmt.Errorf("failed to get max block from blocks table: %w", err)
	}

	cs.maxBlockTransactions, err = chwrapper.GetLatestBlockForChain(cs.conn, "raw_transactions", cs.chainId)
	if err != nil {
		return fmt.Errorf("failed to get max block from transactions table: %w", err)
	}

	cs.maxBlockTraces, err = chwrapper.GetLatestBlockForChain(cs.conn, "raw_traces", cs.chainId)
	if err != nil {
		return fmt.Errorf("failed to get max block from traces table: %w", err)
	}

	cs.maxBlockLogs, err = chwrapper.GetLatestBlockForChain(cs.conn, "raw_logs", cs.chainId)
	if err != nil {
		return fmt.Errorf("failed to get max block from logs table: %w", err)
	}

	log.Printf("[Chain %d] Starting from block %d", cs.chainId, startBlock)

	// Get latest block from RPC
	latestBlock, err := cs.fetcher.GetLatestBlock()
	if err != nil {
		return fmt.Errorf("failed to get latest block: %w", err)
	}

	log.Printf("[Chain %d] Latest block on chain: %d", cs.chainId, latestBlock)

	// Start producer (fetcher) goroutine
	cs.wg.Add(1)
	go cs.fetcherLoop(startBlock, latestBlock)

	// Start consumer (writer) goroutine
	cs.wg.Add(1)
	go cs.writerLoop()

	// Start progress printer
	cs.wg.Add(1)
	go cs.printProgress()

	return nil
}

// Stop gracefully shuts down the syncer
func (cs *ChainSyncer) Stop() {
	log.Printf("[Chain %d] Stopping syncer...", cs.chainId)
	cs.cancel()
	close(cs.blockChan)
	cs.wg.Wait()
	log.Printf("[Chain %d] Syncer stopped", cs.chainId)
}

// Wait blocks until syncer completes
func (cs *ChainSyncer) Wait() {
	cs.wg.Wait()
}

// getStartingBlock determines where to start syncing from
func (cs *ChainSyncer) getStartingBlock() (int64, error) {
	// Get watermark
	watermark, err := chwrapper.GetWatermark(cs.conn, cs.chainId)
	if err != nil {
		return 0, fmt.Errorf("failed to get watermark: %w", err)
	}
	cs.watermark = watermark

	// If no watermark, start from block 1
	if watermark == 0 {
		return 1, nil
	}

	// Start from watermark+1
	return int64(watermark + 1), nil
}

// fetcherLoop is the producer goroutine that fetches blocks
func (cs *ChainSyncer) fetcherLoop(startBlock, latestBlock int64) {
	defer cs.wg.Done()

	currentBlock := startBlock

	for {
		select {
		case <-cs.ctx.Done():
			return
		default:
			// Check if we're caught up
			if currentBlock > latestBlock {
				// Poll for new blocks
				time.Sleep(2 * time.Second)

				newLatest, err := cs.fetcher.GetLatestBlock()
				if err != nil {
					log.Printf("[Chain %d] Error getting latest block: %v", cs.chainId, err)
					continue
				}

				if newLatest > latestBlock {
					latestBlock = newLatest
				} else {
					continue
				}
			}

			// Calculate batch range
			endBlock := currentBlock + int64(cs.fetchBatchSize) - 1
			if endBlock > latestBlock {
				endBlock = latestBlock
			}

			// Fetch blocks
			blocks, err := cs.fetcher.FetchBlockRange(currentBlock, endBlock)
			if err != nil {
				log.Printf("[Chain %d] Error fetching blocks %d-%d: %v",
					cs.chainId, currentBlock, endBlock, err)
				time.Sleep(1 * time.Second)
				continue
			}

			// Update fetched counter
			cs.mu.Lock()
			cs.blocksFetched += int64(len(blocks))
			cs.mu.Unlock()

			// Send to channel (will block if buffer is full - backpressure)
			select {
			case cs.blockChan <- blocks:
				currentBlock = endBlock + 1
			case <-cs.ctx.Done():
				return
			}
		}
	}
}

// writerLoop is the consumer goroutine that writes to ClickHouse
func (cs *ChainSyncer) writerLoop() {
	defer cs.wg.Done()

	ticker := time.NewTicker(cs.flushInterval)
	defer ticker.Stop()

	var buffer []*rpc.NormalizedBlock

	flush := func() {
		if len(buffer) == 0 {
			return
		}

		if err := cs.writeBlocks(buffer); err != nil {
			log.Printf("[Chain %d] Error writing blocks: %v", cs.chainId, err)
			// TODO: Implement retry logic
			return
		}

		// Update written counter
		cs.mu.Lock()
		cs.blocksWritten += int64(len(buffer))
		cs.mu.Unlock()

		// Clear buffer
		buffer = nil
	}

	for {
		select {
		case <-cs.ctx.Done():
			// Final flush before exit
			flush()
			return

		case blocks, ok := <-cs.blockChan:
			if !ok {
				// Channel closed, final flush
				flush()
				return
			}

			// Add to buffer
			buffer = append(buffer, blocks...)

		case <-ticker.C:
			// Time-based flush
			flush()
		}
	}
}

// writeBlocks writes blocks to all tables in parallel and updates watermark
func (cs *ChainSyncer) writeBlocks(blocks []*rpc.NormalizedBlock) error {
	if len(blocks) == 0 {
		return nil
	}

	ctx := context.Background()
	g, ctx := errgroup.WithContext(ctx)

	// Insert to blocks table
	g.Go(func() error {
		return InsertBlocks(ctx, cs.conn, cs.chainId, blocks, cs.maxBlockBlocks)
	})

	// Insert to transactions table
	g.Go(func() error {
		return InsertTransactions(ctx, cs.conn, cs.chainId, blocks, cs.maxBlockTransactions)
	})

	// Insert to traces table
	g.Go(func() error {
		return InsertTraces(ctx, cs.conn, cs.chainId, blocks, cs.maxBlockTraces)
	})

	// Insert to logs table
	g.Go(func() error {
		return InsertLogs(ctx, cs.conn, cs.chainId, blocks, cs.maxBlockLogs)
	})

	// Wait for all inserts to complete
	if err := g.Wait(); err != nil {
		return fmt.Errorf("failed to insert blocks: %w", err)
	}

	// Update watermark to the highest block number in this batch
	maxBlock := uint32(0)
	for _, b := range blocks {
		blockNum, err := hexToUint32(b.Block.Number)
		if err != nil {
			continue
		}
		if blockNum > maxBlock {
			maxBlock = blockNum
		}
	}

	if maxBlock > cs.watermark {
		if err := chwrapper.SetWatermark(cs.conn, cs.chainId, maxBlock); err != nil {
			return fmt.Errorf("failed to update watermark: %w", err)
		}
		cs.watermark = maxBlock
	}

	return nil
}

// printProgress prints sync progress periodically
func (cs *ChainSyncer) printProgress() {
	defer cs.wg.Done()

	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-cs.ctx.Done():
			return
		case <-ticker.C:
			cs.mu.Lock()
			fetched := cs.blocksFetched
			written := cs.blocksWritten
			cs.mu.Unlock()

			elapsed := time.Since(cs.startTime)
			fetchRate := float64(fetched) / elapsed.Seconds()
			writeRate := float64(written) / elapsed.Seconds()
			lag := fetched - written

			log.Printf("[Chain %d] Fetched: %d (%.1f/s) | Written: %d (%.1f/s) | Lag: %d | Watermark: %d",
				cs.chainId, fetched, fetchRate, written, writeRate, lag, cs.watermark)
		}
	}
}
