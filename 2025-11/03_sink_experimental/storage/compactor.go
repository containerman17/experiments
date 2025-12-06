package storage

import (
	"context"
	"evm-sink/consts"
	"fmt"
	"log"
	"sync"
	"time"
)

func formatSize(bytes int) string {
	const unit = 1024
	if bytes < unit {
		return fmt.Sprintf("%d B", bytes)
	}
	div, exp := unit, 0
	for n := bytes / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(bytes)/float64(div), "KMG"[exp])
}

const (
	MinBlocksBeforeCompaction = consts.StorageMinBlocksBeforeCompaction
	CompactionCheckInterval   = consts.StorageCompactionInterval
)

type Compactor struct {
	storage  *Storage
	s3       *S3Client
	chainID  uint64
	s3Prefix string
	stopCh   chan struct{}
	doneCh   chan struct{}
}

func NewCompactor(storage *Storage, s3 *S3Client, chainID uint64, s3Prefix string) *Compactor {
	return &Compactor{
		storage:  storage,
		s3:       s3,
		chainID:  chainID,
		s3Prefix: s3Prefix,
		stopCh:   make(chan struct{}),
		doneCh:   make(chan struct{}),
	}
}

func (c *Compactor) Start(ctx context.Context) {
	go c.run(ctx)
}

func (c *Compactor) Stop() {
	close(c.stopCh)
	<-c.doneCh
}

func (c *Compactor) run(ctx context.Context) {
	defer close(c.doneCh)

	ticker := time.NewTicker(CompactionCheckInterval)
	defer ticker.Stop()

	for {
		select {
		case <-c.stopCh:
			return
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.compact(ctx)
		}
	}
}

func (c *Compactor) compact(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		if !c.compactParallel(ctx) {
			return
		}
	}
}

func (c *Compactor) compactParallel(ctx context.Context) bool {
	const (
		MaxBatches  = 100
		Concurrency = 50
	)

	startTime := time.Now()

	// Check if we have enough blocks
	blockCount := c.storage.BlockCount(c.chainID)
	if blockCount < MinBlocksBeforeCompaction+BatchSize {
		return false
	}

	firstBlock, ok := c.storage.FirstBlock(c.chainID)
	if !ok {
		return false
	}

	latestBlock, ok := c.storage.LatestBlock(c.chainID)
	if !ok {
		return false
	}

	// Calculate range to compact
	batchStart := BatchStart(firstBlock)
	var numBatches int

	for i := 0; i < MaxBatches; i++ {
		start := batchStart + uint64(i)*BatchSize
		end := BatchEnd(start)
		if latestBlock < end+MinBlocksBeforeCompaction {
			break
		}
		numBatches++
	}

	if numBatches == 0 {
		return false
	}

	rangeStart := batchStart
	rangeEnd := BatchEnd(batchStart + uint64(numBatches-1)*BatchSize)

	// Read all blocks in one iterator pass
	allBlocks, err := c.storage.GetBlockRange(c.chainID, rangeStart, rangeEnd)
	if err != nil {
		log.Printf("[Compactor] Chain %d: failed to read block range: %v", c.chainID, err)
		return false
	}

	// Sort into batches
	batches := make([][][]byte, numBatches)
	for i := 0; i < numBatches; i++ {
		start := batchStart + uint64(i)*BatchSize
		batch := make([][]byte, BatchSize)
		complete := true

		for j := 0; j < BatchSize; j++ {
			blockNum := start + uint64(j)
			data, ok := allBlocks[blockNum]
			if !ok {
				complete = false
				break
			}
			batch[j] = data
		}

		if !complete {
			numBatches = i // Truncate at first incomplete batch
			break
		}
		batches[i] = batch
	}

	if numBatches == 0 {
		return false
	}
	batches = batches[:numBatches]

	// Parallel compress + upload with single concurrency limit
	type result struct {
		batchStart uint64
		size       int
		err        error
	}
	results := make([]result, numBatches)

	var wg sync.WaitGroup
	sem := make(chan struct{}, Concurrency)

	for i, batch := range batches {
		wg.Add(1)
		go func(idx int, blocks [][]byte) {
			defer wg.Done()

			sem <- struct{}{}
			defer func() { <-sem }()

			batchStartBlock := batchStart + uint64(idx)*BatchSize

			compressed, err := CompressBlocks(blocks)
			if err != nil {
				results[idx] = result{batchStartBlock, 0, err}
				return
			}

			key := S3Key(c.s3Prefix, c.chainID, batchStartBlock, BatchEnd(batchStartBlock))
			size, err := c.s3.UploadCompressed(ctx, key, compressed)
			results[idx] = result{batchStartBlock, size, err}
		}(i, batch)
	}

	wg.Wait()

	// Find contiguous success prefix
	var committed int
	var totalSize int
	var lastEnd uint64

	for _, r := range results {
		if r.err != nil {
			break
		}
		committed++
		totalSize += r.size
		lastEnd = BatchEnd(r.batchStart)
	}

	if committed == 0 {
		return false
	}

	// Write meta file first
	meta := ChainMeta{LastCompactedBlock: lastEnd}
	if err := c.s3.PutMeta(ctx, c.s3Prefix, c.chainID, meta); err != nil {
		log.Printf("[Compactor] Chain %d: failed to write meta: %v", c.chainID, err)
		return false
	}

	// Delete from PebbleDB using range delete
	deleteStart := batchStart
	deleteEnd := lastEnd
	if err := c.storage.DeleteBlockRange(c.chainID, deleteStart, deleteEnd); err != nil {
		log.Printf("[Compactor] Chain %d: delete failed: %v", c.chainID, err)
	}

	log.Printf("[Compactor] Chain %d: compacted %d batches (%d-%d) %s in %.1fs",
		c.chainID, committed, batchStart, lastEnd, formatSize(totalSize), time.Since(startTime).Seconds())

	return true
}
