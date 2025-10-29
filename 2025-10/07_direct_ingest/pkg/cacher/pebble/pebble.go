package pebble

import (
	"fmt"
	"ingest/pkg/cacher"

	"github.com/cockroachdb/pebble/v2"
	"github.com/cockroachdb/pebble/v2/sstable/block"
)

// PebbleCache implements the Cache interface using PebbleDB
type PebbleCache struct {
	db *pebble.DB
}

// New creates a new PebbleDB cache at the specified path
func New(dbPath string) (*PebbleCache, error) {
	opts := &pebble.Options{}

	// Use zstd compression level 1 for all levels
	opts.ApplyCompressionSettings(func() pebble.DBCompressionSettings {
		return pebble.UniformDBCompressionSettings(block.FastCompression)
	})

	db, err := pebble.Open(dbPath, opts)
	if err != nil {
		return nil, fmt.Errorf("failed to open pebble db: %w", err)
	}

	return &PebbleCache{db: db}, nil
}

// GetCompleteBlock retrieves or fetches a complete block as JSON bytes
func (c *PebbleCache) GetCompleteBlock(blockNum int64, fetch func() ([]byte, error)) ([]byte, error) {
	key := []byte(fmt.Sprintf("block:%d", blockNum))

	// Try to get from cache
	value, closer, err := c.db.Get(key)
	if err == nil {
		// Cache hit - copy and return
		defer closer.Close()
		result := make([]byte, len(value))
		copy(result, value)
		return result, nil
	}

	if err != pebble.ErrNotFound {
		// Unexpected error
		return nil, fmt.Errorf("cache get error for block %d: %w", blockNum, err)
	}

	// Cache miss - fetch the block
	data, err := fetch()
	if err != nil {
		return nil, err
	}

	// Store in cache
	if err := c.db.Set(key, data, pebble.Sync); err != nil {
		// Log error but don't fail the request
		fmt.Printf("Warning: failed to cache block %d: %v\n", blockNum, err)
	}

	return data, nil
}

// Close closes the PebbleDB database
func (c *PebbleCache) Close() error {
	return c.db.Close()
}

// Ensure PebbleCache implements Cache interface
var _ cacher.Cache = (*PebbleCache)(nil)
