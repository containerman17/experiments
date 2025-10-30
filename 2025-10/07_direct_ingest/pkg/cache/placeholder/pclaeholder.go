package placeholder

import (
	"ingest/pkg/cache"
)

// PlaceholderCache implements the Cache interface but does no caching
type PlaceholderCache struct{}

// New creates a new placeholder cache that does nothing
func New() (*PlaceholderCache, error) {
	return &PlaceholderCache{}, nil
}

// GetCompleteBlock just calls fetch without any caching
func (c *PlaceholderCache) GetCompleteBlock(blockNum int64, fetch func() ([]byte, error)) ([]byte, error) {
	return fetch()
}

// Close does nothing
func (c *PlaceholderCache) Close() error {
	return nil
}

// Ensure PlaceholderCache implements Cache interface
var _ cache.Cache = (*PlaceholderCache)(nil)
