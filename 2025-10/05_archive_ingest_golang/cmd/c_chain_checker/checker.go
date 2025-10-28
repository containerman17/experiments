package main

import (
	"archive-ingest/pkg/archiver"
	"encoding/json"
	"fmt"
	"log"
	"strings"
)

const blockchainDir = "/data/2q9e4r6Mu3U68nU1fYjgbR6JvwrRx36CohpAX5UQxse55x1Q5_v2/"

func main() {
	batchSize := 10
	reader := archiver.NewBatchReader(blockchainDir, 1, batchSize)
	defer reader.Close()

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
