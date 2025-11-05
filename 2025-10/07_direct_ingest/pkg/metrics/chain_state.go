package metrics

import (
	"sync"
	"time"
)

// ChainState tracks the progress of a single chain
type ChainState struct {
	LatestBlockTime   time.Time
	LatestBlockNumber uint32
	LastProcessed     map[string]map[string]time.Time // [metric][granularity]->lastPeriod
	mu                sync.RWMutex
}

// NewChainState creates a new chain state tracker
func NewChainState() *ChainState {
	return &ChainState{
		LastProcessed: make(map[string]map[string]time.Time),
	}
}

// UpdateLatestBlock updates the latest block information
func (cs *ChainState) UpdateLatestBlock(blockTime time.Time, blockNumber uint32) {
	cs.mu.Lock()
	defer cs.mu.Unlock()

	cs.LatestBlockTime = blockTime
	cs.LatestBlockNumber = blockNumber
}

// GetLatestBlockTime returns the latest block time
func (cs *ChainState) GetLatestBlockTime() time.Time {
	cs.mu.RLock()
	defer cs.mu.RUnlock()

	return cs.LatestBlockTime
}

// GetLastProcessed returns the last processed period for a metric/granularity
func (cs *ChainState) GetLastProcessed(metric, granularity string) time.Time {
	cs.mu.RLock()
	defer cs.mu.RUnlock()

	if cs.LastProcessed[metric] == nil {
		return time.Time{} // Zero time - never processed
	}

	return cs.LastProcessed[metric][granularity]
}

// SetLastProcessed updates the last processed period for a metric/granularity
func (cs *ChainState) SetLastProcessed(metric, granularity string, period time.Time) {
	cs.mu.Lock()
	defer cs.mu.Unlock()

	if cs.LastProcessed[metric] == nil {
		cs.LastProcessed[metric] = make(map[string]time.Time)
	}

	cs.LastProcessed[metric][granularity] = period
}
