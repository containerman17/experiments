package main

import (
	"fmt"
	"ingest/pkg/cacher/pebble"
	"ingest/pkg/cacher/placeholder"
	"ingest/pkg/rpc"
	"log"
	"math/rand"
	"sync"
	"time"
)

func main() {
	// Hardcoded configuration
	rpcURL := "http://localhost:9650/ext/bc/C/rpc"
	startBlock := int64(1 + rand.Int63n(70000000))
	// startBlock := int64(1)
	chunkSize := int64(100) // Process  blocks at a time
	rpcConcurrency := 300
	maxRetries := 100
	retryDelay := 100 * time.Millisecond
	debugConcurrency := 200
	batchSize := 1
	debugBatchSize := 1

	// Create cache
	cache, err := pebble.New("./data")
	if err != nil {
		log.Fatalf("Failed to create cache: %v", err)
	}
	defer cache.Close()

	placeholderCache, err := placeholder.New()
	if err != nil {
		log.Fatalf("Failed to create placeholder cache: %v", err)
	}
	defer placeholderCache.Close()

	_ = placeholderCache
	_ = cache

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
		MaxRetries:       maxRetries,
		RetryDelay:       retryDelay,
		DebugConcurrency: debugConcurrency,
		BatchSize:        batchSize,
		DebugBatchSize:   debugBatchSize,
		Cache:            cache,
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
	fmt.Printf("RPC Concurrency: %d\n\n", rpcConcurrency)

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

		//Print fist block
		// if blocks[0].Block.Number == fmt.Sprintf("0x%x", startBlock) {
		// 	blockJson, err := json.MarshalIndent(blocks[0], "", "  ")
		// 	if err != nil {
		// 		log.Fatalf("Error marshaling first block to JSON: %v\n", err)
		// 	}

		// 	err = os.WriteFile(fmt.Sprintf("./example_block_%d.json", startBlock), blockJson, 0644)
		// 	if err != nil {
		// 		log.Fatalf("Error writing first block to file: %v\n", err)
		// 	}
		// }

		// for _, block := range blocks {
		// 	fmt.Printf("Uncles: %+v\n", block.Block.Uncles)
		// }

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
