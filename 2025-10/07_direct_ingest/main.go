package main

import (
	"fmt"
	"ingest/pkg/rpc"
	"log"
	"sync"
	"time"
)

func main() {
	// Hardcoded configuration
	rpcURL := "http://localhost:9650/ext/bc/C/rpc"
	startBlock := int64(67000000) // Start from block 1 (genesis block 0 is not traceable)
	chunkSize := int64(300)       // Process 100 blocks at a time
	batchSize := 10
	debugBatchSize := 1
	rpcConcurrency := 500
	debugConcurrency := 500
	maxRetries := 100
	retryDelay := 100 * time.Millisecond

	// Progress tracking
	var (
		mu                 sync.Mutex
		lastPrintTime      = time.Now()
		startTime          = time.Now()
		totalBlocksFetched int64
		totalTxsFetched    int64
	)

	// Create fetcher with progress callback
	fetcher := rpc.NewFetcher(rpc.FetcherOptions{
		RpcURL:           rpcURL,
		RpcConcurrency:   rpcConcurrency,
		DebugConcurrency: debugConcurrency,
		BatchSize:        batchSize,
		DebugBatchSize:   debugBatchSize,
		MaxRetries:       maxRetries,
		RetryDelay:       retryDelay,
		ProgressCallback: func(phase string, current, total int64, txCount int) {
			mu.Lock()
			defer mu.Unlock()

			totalTxsFetched += int64(txCount)

			// Print stats every 2 seconds
			now := time.Now()
			if now.Sub(lastPrintTime) >= 2*time.Second {
				totalElapsed := now.Sub(startTime).Seconds()

				fmt.Printf("[%v] Blocks: %d | Blocks/sec: %.1f | Txs/sec: %.1f\n",
					time.Since(startTime).Round(time.Second),
					totalBlocksFetched,
					float64(totalBlocksFetched)/totalElapsed,
					float64(totalTxsFetched)/totalElapsed)

				lastPrintTime = now
			}
		},
	})

	// Get latest block
	latestBlock, err := fetcher.GetLatestBlock()
	if err != nil {
		log.Fatalf("Failed to get latest block: %v", err)
	}

	fmt.Printf("Processing blocks %d to %d in chunks of %d\n", startBlock, latestBlock, chunkSize)
	fmt.Printf("Batch: %d, Concurrency: %d\n\n", batchSize, rpcConcurrency)

	// Process blocks in chunks
	for from := startBlock; from <= latestBlock; from += chunkSize {
		to := from + chunkSize - 1
		if to > latestBlock {
			to = latestBlock
		}

		// Fetch chunk
		blocks, err := fetcher.FetchBlockRange(from, to)
		if err != nil {
			log.Fatalf("Failed to fetch blocks %d-%d: %v", from, to, err)
		}

		// Count transactions in chunk
		chunkTxs := 0
		chunkTraces := 0
		for _, block := range blocks {
			chunkTxs += len(block.Block.Transactions)
			for _, trace := range block.Traces {
				if trace.Result != nil {
					chunkTraces++
				}
			}
		}

		// Update total progress
		mu.Lock()
		totalBlocksFetched += int64(len(blocks))
		mu.Unlock()

		// TODO: Process/save blocks here (e.g., write to database or file)
		// For now, just discard them to free memory
		blocks = nil
	}

	// Calculate final statistics
	elapsed := time.Since(startTime)

	fmt.Printf("\n=== Complete ===\n")
	fmt.Printf("Time: %v | Blocks: %d | Txs: %d\n",
		elapsed.Round(time.Second), totalBlocksFetched, totalTxsFetched)
	fmt.Printf("Overall: %.1f blocks/sec | %.1f txs/sec\n",
		float64(totalBlocksFetched)/elapsed.Seconds(),
		float64(totalTxsFetched)/elapsed.Seconds())
}
