package main

import (
	"fmt"
	"io"
	"log"
	"time"
)

func main() {
	rootDir := "/data/2q9e4r6Mu3U68nU1fYjgbR6JvwrRx36CohpAX5UQxse55x1Q5_v2"
	startBlock := int64(1234567)

	fmt.Printf("Starting from block %d\n", startBlock)
	fmt.Printf("Reading from %s\n", rootDir)

	reader := NewBlockReader(rootDir, startBlock)
	defer reader.Close()

	startTime := time.Now()
	blockCount := int64(0)
	txCount := int64(0)

	// Stats tracking
	lastStatsTime := time.Now()
	lastStatsBlocks := int64(0)
	lastStatsTxs := int64(0)

	// Print stats every second
	statsTicker := time.NewTicker(1 * time.Second)
	defer statsTicker.Stop()

	go func() {
		for range statsTicker.C {
			now := time.Now()
			elapsed := now.Sub(lastStatsTime).Seconds()

			blocksThisSecond := blockCount - lastStatsBlocks
			txsThisSecond := txCount - lastStatsTxs

			blocksPerSec := float64(blocksThisSecond) / elapsed
			txsPerSec := float64(txsThisSecond) / elapsed

			totalElapsed := now.Sub(startTime).Seconds()
			avgBlocksPerSec := float64(blockCount) / totalElapsed
			avgTxsPerSec := float64(txCount) / totalElapsed

			fmt.Printf("Current: %.1f blocks/sec, %.1f txs/sec | Avg: %.1f blocks/sec, %.1f txs/sec | Total: %d blocks, %d txs\n",
				blocksPerSec, txsPerSec, avgBlocksPerSec, avgTxsPerSec, blockCount, txCount)

			lastStatsTime = now
			lastStatsBlocks = blockCount
			lastStatsTxs = txCount
		}
	}()

	// Read blocks
	for {
		block, err := reader.NextBlock()
		if err != nil {
			if err == io.EOF {
				fmt.Println("Reached end of data")
				break
			}
			log.Fatalf("Error reading block: %v", err)
		}

		blockCount++
		txCount += int64(len(block.Block.Transactions))

		// Process for 30 seconds then exit
		if time.Since(startTime) > 30*time.Second {
			fmt.Println("Test complete after 30 seconds")
			break
		}
	}

	// Print final stats
	totalElapsed := time.Since(startTime).Seconds()
	fmt.Printf("\nFinal statistics:\n")
	fmt.Printf("Total blocks: %d\n", blockCount)
	fmt.Printf("Total transactions: %d\n", txCount)
	fmt.Printf("Time elapsed: %.2f seconds\n", totalElapsed)
	fmt.Printf("Average blocks/sec: %.2f\n", float64(blockCount)/totalElapsed)
	fmt.Printf("Average txs/sec: %.2f\n", float64(txCount)/totalElapsed)
}
