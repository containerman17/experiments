package storage

import (
	"context"
	"fmt"
	"log"
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
	MinBlocksBeforeCompaction = 1000 // Keep at least 1k blocks in PebbleDB
	CompactionCheckInterval   = 10 * time.Second
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
	// Loop until we can't compact anymore
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		if !c.compactOneBatch(ctx) {
			return // Nothing more to compact
		}
	}
}

// compactOneBatch compacts one batch, returns true if successful (more might be available)
func (c *Compactor) compactOneBatch(ctx context.Context) bool {
	// Check if we have enough blocks to start compacting
	blockCount := c.storage.BlockCount(c.chainID)
	if blockCount < MinBlocksBeforeCompaction+BatchSize {
		return false
	}

	// Find first block
	firstBlock, ok := c.storage.FirstBlock(c.chainID)
	if !ok {
		return false
	}

	// Align to batch boundary (1-based: 1-100, 101-200, etc.)
	batchStart := BatchStart(firstBlock)

	// Check we still have buffer after this compaction
	latestBlock, ok := c.storage.LatestBlock(c.chainID)
	if !ok {
		return false
	}

	// Make sure we keep MinBlocksBeforeCompaction in hot storage
	batchEnd := BatchEnd(batchStart)
	if latestBlock < batchEnd+MinBlocksBeforeCompaction {
		return false
	}

	// Check if we have all 100 consecutive blocks
	hasAll, err := c.storage.HasConsecutiveBlocks(c.chainID, batchStart, BatchSize)
	if err != nil {
		log.Printf("[Compactor] Chain %d: error checking blocks: %v", c.chainID, err)
		return false
	}
	if !hasAll {
		return false
	}

	// Read all blocks
	blocks, err := c.storage.GetBatch(c.chainID, batchStart, BatchSize)
	if err != nil {
		log.Printf("[Compactor] Chain %d: error reading batch at %d: %v", c.chainID, batchStart, err)
		return false
	}

	// Verify all blocks are present
	for i, block := range blocks {
		if block == nil {
			log.Printf("[Compactor] Chain %d: missing block %d in batch", c.chainID, batchStart+uint64(i))
			return false
		}
	}

	// Upload to S3
	key := S3Key(c.s3Prefix, c.chainID, batchStart, batchEnd)

	size, err := c.s3.Upload(ctx, key, blocks)
	if err != nil {
		log.Printf("[Compactor] Chain %d: error uploading batch %d-%d: %v", c.chainID, batchStart, batchEnd, err)
		return false
	}

	// Delete from PebbleDB
	if err := c.storage.DeleteBatch(c.chainID, batchStart, BatchSize); err != nil {
		log.Printf("[Compactor] Chain %d: error deleting batch %d-%d: %v", c.chainID, batchStart, batchEnd, err)
		return false
	}

	log.Printf("[Compactor] Chain %d: compacted blocks %d-%d (%s)", c.chainID, batchStart, batchEnd, formatSize(size))
	return true
}
