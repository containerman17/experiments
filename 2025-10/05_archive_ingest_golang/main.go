package main

import (
	"archive-ingest/pkg/archiver"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"

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

	// Create reader
	reader := archiver.NewBlockReader(blockchainDir, 1)
	defer reader.Close()

	// If RPC URL provided, start writer in background
	if rpcURL != "" {
		writer := archiver.NewBlockWriter(blockchainDir, reader, rpcURL, includeTraces)

		// Start writer in background
		go func() {
			if err := writer.Start(); err != nil {
				log.Fatal("Writer error:", err)
			}
		}()

		fmt.Printf("Writer started with RPC: %s, traces: %v\n", rpcURL, includeTraces)
	} else {
		fmt.Println("No RPC_URL provided, reading from existing archives only")
	}

	// Read blocks (from archives or buffer)
	for {
		block, err := reader.NextBlock()
		if err != nil {
			log.Fatal("Error reading block:", err)
		}

		// Just print block number for now
		var blockNum int64
		if err := json.Unmarshal(block.Block.Number, &blockNum); err != nil {
			// Try as hex string
			var blockNumStr string
			if err := json.Unmarshal(block.Block.Number, &blockNumStr); err == nil {
				if _, err := fmt.Sscanf(blockNumStr, "0x%x", &blockNum); err == nil {

					if blockNum%100 == 0 {
						fmt.Printf("Block: %d\n", blockNum)
					}

					if blockNum == 15723 {
						tracesJSON, err := json.MarshalIndent(block.Traces, "", "  ")
						if err != nil {
							fmt.Printf("Failed to marshal traces to JSON: %v\n", err)
						} else {
							fmt.Println(string(tracesJSON))
						}
					}
				} else {
					log.Fatal("Error parsing block number:", err)
				}
			} else {
				log.Fatal("Error parsing block number:", err)
			}
		} else {
			fmt.Printf("Block: %d\n", blockNum)
		}

		//TODO: check traces of block 15723
	}
}
