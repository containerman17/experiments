package main

import (
	"archive-ingest/pkg/archiver"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/joho/godotenv"
)

const rootDir = "/data/"

func main() {
	err := godotenv.Load()
	if err != nil {
		log.Fatal("Error loading .env file:", err)
	}

	blockchainId := os.Getenv("BLOCKCHAIN_ID")
	if blockchainId == "" {
		log.Fatal("BLOCKCHAIN_ID is not set")
	}

	blockchainDir := filepath.Join(rootDir, blockchainId)

	// Create directory if it doesn't exist
	if err := os.MkdirAll(blockchainDir, 0755); err != nil {
		log.Fatal("Failed to create blockchain directory:", err)
	}

	// Check if RPC URL is provided for writing
	rpcURL := os.Getenv("RPC_URL")
	includeTraces := true

	// Always use BatchReader
	batchSize := 10
	reader := archiver.NewBatchReader(blockchainDir, 1, batchSize)
	defer reader.Close()

	// If RPC URL provided, start writer for live mode
	if rpcURL != "" {
		fetcher := archiver.NewFetcher(archiver.FetcherOptions{
			RpcURL:           rpcURL,
			IncludeTraces:    includeTraces,
			RpcConcurrency:   300,
			DebugConcurrency: 100,
		})

		writer := archiver.NewBlockWriter(blockchainDir, reader, fetcher)

		// Start writer in background
		go func() {
			if err := writer.Start(); err != nil {
				log.Fatal("Writer error:", err)
			}
		}()

		fmt.Printf("Writer started with RPC: %s, traces: %v\n", rpcURL, includeTraces)
		fmt.Printf("Batch reader started with batch size: %d files (with live mode support)\n", batchSize)
	} else {
		fmt.Printf("Batch reader started with batch size: %d files (processing %d blocks at once)\n", batchSize, batchSize*1000)
	}

	// Read blocks (from archives or buffer)
	startTime := time.Now()
	var lastBlockNum int64 = -1
	for {
		block, err := reader.NextBlock()
		if err != nil {
			log.Fatal("Error reading block:", err)
		}

		// Parse block number
		var blockNum int64
		if err := json.Unmarshal(block.Block.Number, &blockNum); err != nil {
			// Try as hex string
			var blockNumStr string
			if err := json.Unmarshal(block.Block.Number, &blockNumStr); err == nil {
				if _, err := fmt.Sscanf(blockNumStr, "0x%x", &blockNum); err != nil {
					log.Fatal("Error parsing block number:", err)
				}
			} else {
				log.Fatal("Error parsing block number:", err)
			}
		}

		if blockNum%200 == 0 {
			fmt.Printf("Block: %d\n", blockNum)
		}

		// Exit after reaching 15k blocks
		if blockNum == 30000 {
			elapsed := time.Since(startTime)
			fmt.Printf("\nReached block %d in %.2f seconds\n", blockNum, elapsed.Seconds())
			// os.Exit(0)
		}

		// Check sequential order
		if lastBlockNum != -1 && blockNum != lastBlockNum+1 {
			log.Fatalf("Block numbers out of order! Expected %d, got %d", lastBlockNum+1, blockNum)
		}
		lastBlockNum = blockNum
	}
}
