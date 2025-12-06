package main

import (
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"

	"github.com/cockroachdb/pebble/v2"
)

type chainImport struct {
	chainID uint64
	oldPath string
}

func main() {
	chains := []chainImport{
		// {68414, "/root/clickhouse-metrics-poc/rpc_cache/68414"},
		// {836, "/root/clickhouse-metrics-poc/rpc_cache/836"},
		{43114, "/root/clickhouse-metrics-poc/rpc_cache/43114"},
	}

	// Open new DB directly for faster writes - disable WAL for max speed
	newDb, err := pebble.Open("./data/pebble", &pebble.Options{
		DisableWAL: true,
	})
	if err != nil {
		log.Fatalf("Failed to open new db: %v", err)
	}
	defer newDb.Close()

	for _, chain := range chains {
		log.Printf("\n=== Processing chain %d ===", chain.chainID)

		// Find last block in new DB
		newLast := findLastBlockNew(newDb, chain.chainID)
		log.Printf("New DB last block: %d", newLast)

		// Open old database
		oldDb, err := pebble.Open(chain.oldPath, &pebble.Options{
			ReadOnly: true,
		})
		if err != nil {
			log.Fatalf("Failed to open old db at %s: %v", chain.oldPath, err)
		}

		// Find last block in old DB
		oldLast := findLastBlock(oldDb)
		log.Printf("Old DB last block: %d", oldLast)

		if newLast >= oldLast {
			log.Printf("Nothing to import (new DB is up to date)")
			oldDb.Close()
			continue
		}

		// Import blocks (will verify no gaps during import)
		startBlock := newLast + 1
		log.Printf("Importing blocks %d to %d (%d blocks)", startBlock, oldLast, oldLast-startBlock+1)

		imported := importBlocks(oldDb, newDb, chain.chainID, startBlock, oldLast)
		log.Printf("Imported %d blocks", imported)

		oldDb.Close()
	}

	log.Println("\n=== Import complete ===")
}

func findLastBlock(db *pebble.DB) uint64 {
	iter, err := db.NewIter(&pebble.IterOptions{
		LowerBound: []byte("block:"),
		UpperBound: []byte("block;"),
	})
	if err != nil {
		log.Fatalf("Failed to create iterator: %v", err)
	}
	defer iter.Close()

	if !iter.Last() {
		return 0
	}

	blockNum := parseOldBlockKey(iter.Key())
	return blockNum
}

func findLastBlockNew(db *pebble.DB, chainID uint64) uint64 {
	prefix := fmt.Sprintf("block:%d:", chainID)
	iter, err := db.NewIter(&pebble.IterOptions{
		LowerBound: []byte(prefix),
		UpperBound: []byte(fmt.Sprintf("block:%d;", chainID)),
	})
	if err != nil {
		log.Fatalf("Failed to create iterator: %v", err)
	}
	defer iter.Close()

	if !iter.Last() {
		return 0
	}

	// Parse new format: block:43114:00000000000000000001
	parts := strings.Split(string(iter.Key()), ":")
	if len(parts) != 3 {
		return 0
	}
	num, err := strconv.ParseUint(parts[2], 10, 64)
	if err != nil {
		return 0
	}
	return num
}

func parseOldBlockKey(key []byte) uint64 {
	// Format: block:00000000000001
	parts := strings.Split(string(key), ":")
	if len(parts) != 2 {
		return 0
	}
	num, err := strconv.ParseUint(parts[1], 10, 64)
	if err != nil {
		return 0
	}
	return num
}

func importBlocks(oldDb, newDb *pebble.DB, chainID, start, end uint64) int {
	count := 0
	batchSize := 1000
	expectedBlock := start
	startTime := time.Now()
	totalBlocks := end - start + 1

	for blockNum := start; blockNum <= end; {
		batchEnd := blockNum + uint64(batchSize) - 1
		if batchEnd > end {
			batchEnd = end
		}

		iter, err := oldDb.NewIter(&pebble.IterOptions{
			LowerBound: []byte(fmt.Sprintf("block:%014d", blockNum)),
			UpperBound: []byte(fmt.Sprintf("block:%014d", batchEnd+1)),
		})
		if err != nil {
			log.Fatalf("Failed to create iterator: %v", err)
		}

		// Use a batch for writes - much faster than individual syncs
		batch := newDb.NewBatch()

		for iter.First(); iter.Valid(); iter.Next() {
			oldBlockNum := parseOldBlockKey(iter.Key())

			// Verify no gaps
			if oldBlockNum != expectedBlock {
				log.Fatalf("Gap detected: expected block %d but got %d", expectedBlock, oldBlockNum)
			}

			val := iter.Value()

			// Verify value is not empty/corrupt
			if len(val) < 100 {
				log.Fatalf("Corrupt block %d: value too small (%d bytes)", oldBlockNum, len(val))
			}

			// Write to batch with new key format
			newKey := fmt.Sprintf("block:%d:%020d", chainID, oldBlockNum)
			if err := batch.Set([]byte(newKey), val, nil); err != nil {
				log.Fatalf("Failed to batch block %d: %v", oldBlockNum, err)
			}

			count++
			expectedBlock++
		}

		iter.Close()

		// Commit batch without sync (NoSync) - sync at end of chain
		if err := batch.Commit(pebble.NoSync); err != nil {
			log.Fatalf("Failed to commit batch: %v", err)
		}
		batch.Close()

		elapsed := time.Since(startTime).Seconds()
		blocksPerSec := float64(count) / elapsed
		percentage := float64(count) / float64(totalBlocks) * 100
		remaining := totalBlocks - uint64(count)
		etaSeconds := float64(remaining) / blocksPerSec
		eta := time.Duration(etaSeconds * float64(time.Second))

		log.Printf("Progress: %d/%d (%.1f%%) | %.0f blocks/sec | ETA: %s | current: %d",
			count, totalBlocks, percentage, blocksPerSec, eta.Round(time.Second), blockNum)

		blockNum = batchEnd + 1
	}

	// Final sync
	if err := newDb.Flush(); err != nil {
		log.Fatalf("Failed to flush: %v", err)
	}

	// Verify we got all blocks
	if expectedBlock != end+1 {
		log.Fatalf("Missing blocks at end: expected to reach %d but only got to %d", end, expectedBlock-1)
	}

	return count
}
