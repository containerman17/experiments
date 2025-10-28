package main

import (
	"archive-ingest/pkg/archiver"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

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

	// If RPC URL provided, start writer
	if rpcURL != "" {
		fetcher := archiver.NewFetcher(archiver.FetcherOptions{
			RpcURL:           rpcURL,
			IncludeTraces:    includeTraces,
			RpcConcurrency:   100,
			DebugConcurrency: 100,
		})

		writer := archiver.NewBlockWriter(blockchainDir, fetcher)

		// Start writer in background
		go func() {
			if err := writer.Start(); err != nil {
				log.Fatal("Writer error:", err)
			}
		}()

		fmt.Printf("Writer started with RPC: %s, traces: %v\n", rpcURL, includeTraces)
		fmt.Printf("Batch reader started with batch size: %d files\n", batchSize)
	} else {
		fmt.Printf("Batch reader started with batch size: %d files (read-only mode)\n", batchSize)
	}

	// Read blocks from archives
	var lastBlockNum int64 = -1
	for {
		block, err := reader.NextBlock()
		if err != nil {
			log.Fatal("Error reading block:", err)
		}

		// Parse block number
		var blockNum int64
		decoder := json.NewDecoder(strings.NewReader(string(block.Block.Number)))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&blockNum); err != nil {
			// Try as hex string
			var blockNumStr string
			decoder2 := json.NewDecoder(strings.NewReader(string(block.Block.Number)))
			decoder2.DisallowUnknownFields()
			if err := decoder2.Decode(&blockNumStr); err == nil {
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

		// Check sequential order
		if lastBlockNum != -1 && blockNum != lastBlockNum+1 {
			log.Fatalf("Block numbers out of order! Expected %d, got %d", lastBlockNum+1, blockNum)
		}
		lastBlockNum = blockNum
	}
}
