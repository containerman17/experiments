package cacher

// Cache is an interface for caching complete blockchain blocks.
// Each block is cached as a complete unit (block + receipts + traces) as JSON bytes.
type Cache interface {
	// GetCompleteBlock retrieves or fetches a complete block as JSON bytes
	// If found in cache, returns it immediately
	// If not found, calls fetch(), caches the result, and returns it
	GetCompleteBlock(blockNum int64, fetch func() ([]byte, error)) ([]byte, error)

	// Close closes the cache and releases resources
	Close() error
}
