package cache

import (
	"fmt"
	"path/filepath"
	"strconv"

	"github.com/cockroachdb/pebble/v2"
	"github.com/cockroachdb/pebble/v2/sstable/block"
)

const (
	// blockKeyPrefix is the prefix for block keys
	blockKeyPrefix = "block:"
	// blockKeyPadding is the zero-padded length for block numbers (14 digits supports up to 100 trillion blocks)
	blockKeyPadding = 14
)

// Cache implements caching using PebbleDB
type Cache struct {
	db *pebble.DB
}

// New creates a new PebbleDB cache at the specified path for the given chain ID
func New(dbPath string, chainID uint32) (*Cache, error) {
	chainPath := filepath.Join(dbPath, fmt.Sprintf("%d", chainID))

	opts := &pebble.Options{}

	// Use zstd compression level 1 for all levels
	opts.ApplyCompressionSettings(func() pebble.DBCompressionSettings {
		return pebble.UniformDBCompressionSettings(block.FastCompression)
	})

	db, err := pebble.Open(chainPath, opts)
	if err != nil {
		return nil, fmt.Errorf("failed to open pebble db: %w", err)
	}

	return &Cache{db: db}, nil
}

// formatBlockKey formats a block number as a zero-padded key
func formatBlockKey(blockNum int64) []byte {
	padded := fmt.Sprintf("%0*d", blockKeyPadding, blockNum)
	return []byte(blockKeyPrefix + padded)
}

// parseBlockKey extracts block number from a key, returns -1 if invalid
func parseBlockKey(key []byte) int64 {
	prefix := []byte(blockKeyPrefix)
	if len(key) < len(prefix)+blockKeyPadding {
		return -1
	}
	if string(key[:len(prefix)]) != blockKeyPrefix {
		return -1
	}
	blockStr := string(key[len(prefix) : len(prefix)+blockKeyPadding])
	blockNum, err := strconv.ParseInt(blockStr, 10, 64)
	if err != nil {
		return -1
	}
	return blockNum
}

// GetCompleteBlock retrieves or fetches a complete block as JSON bytes
func (c *Cache) GetCompleteBlock(blockNum int64, fetch func() ([]byte, error)) ([]byte, error) {
	key := formatBlockKey(blockNum)

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

// GetBlockRange retrieves a range of blocks from the cache [from, to] inclusive
func (c *Cache) GetBlockRange(from, to int64) (map[int64][]byte, error) {
	if from > to {
		return nil, fmt.Errorf("invalid range: from %d > to %d", from, to)
	}

	result := make(map[int64][]byte)
	startKey := formatBlockKey(from)
	endKey := formatBlockKey(to + 1) // +1 to make it exclusive for iterator

	iter, err := c.db.NewIter(&pebble.IterOptions{
		LowerBound: startKey,
		UpperBound: endKey,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create iterator: %w", err)
	}
	defer iter.Close()

	for iter.First(); iter.Valid(); iter.Next() {
		key := iter.Key()
		blockNum := parseBlockKey(key)
		if blockNum < 0 || blockNum < from || blockNum > to {
			continue // Skip invalid or out-of-range keys
		}

		value := iter.Value()
		// Copy the value since iterator might reuse the buffer
		result[blockNum] = make([]byte, len(value))
		copy(result[blockNum], value)
	}

	return result, nil
}

// Close closes the PebbleDB database
func (c *Cache) Close() error {
	return c.db.Close()
}
