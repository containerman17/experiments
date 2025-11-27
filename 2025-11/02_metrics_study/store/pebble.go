package store

import (
	"fmt"
	"log"
	"math/big"

	"github.com/cockroachdb/pebble/v2"
)

// Store wraps Pebble with typed methods for metrics storage.
// Key schema:
//
//	m:{chain_id}:{metric}:{gran}:{ts} → value (int64 big-endian)
//	e:{chain_id}:{metric}:{entity_hex} → first_seen_ts (int64)
//	w:{chain_id}:{metric}:{gran} → last_indexed_ts (int64)
type Store struct {
	db *pebble.DB
}

func New(path string) *Store {
	db, err := pebble.Open(path, &pebble.Options{})
	if err != nil {
		log.Fatalf("failed to open pebble: %v", err)
	}
	return &Store{db: db}
}

func (s *Store) Close() error {
	return s.db.Close()
}

// --- Metrics ---

func metricKey(chainID uint32, metric, granularity string, ts int64) []byte {
	return []byte(fmt.Sprintf("m:%d:%s:%s:%020d", chainID, metric, granularity, ts))
}

func (s *Store) SetMetric(chainID uint32, metric, granularity string, ts int64, value *big.Int) error {
	key := metricKey(chainID, metric, granularity, ts)
	// Store as bytes (big-endian, variable length)
	return s.db.Set(key, value.Bytes(), pebble.Sync)
}

func (s *Store) GetMetric(chainID uint32, metric, granularity string, ts int64) (*big.Int, bool) {
	key := metricKey(chainID, metric, granularity, ts)
	val, closer, err := s.db.Get(key)
	if err == pebble.ErrNotFound {
		return nil, false
	}
	if err != nil {
		log.Fatalf("pebble get error: %v", err)
	}
	defer closer.Close()
	return new(big.Int).SetBytes(val), true
}

// MetricPoint represents a single metric data point
type MetricPoint struct {
	Timestamp int64
	Value     string // String representation of uint256
}

// ScanMetrics returns metrics in descending order (newest first) for pagination
func (s *Store) ScanMetrics(chainID uint32, metric, granularity string, startTs, endTs int64, limit int) ([]MetricPoint, int64) {
	prefix := []byte(fmt.Sprintf("m:%d:%s:%s:", chainID, metric, granularity))
	startKey := metricKey(chainID, metric, granularity, startTs)
	endKey := metricKey(chainID, metric, granularity, endTs+1)

	iter, err := s.db.NewIter(&pebble.IterOptions{
		LowerBound: startKey,
		UpperBound: endKey,
	})
	if err != nil {
		log.Fatalf("pebble iter error: %v", err)
	}
	defer iter.Close()

	// Collect all points then reverse for descending order
	var points []MetricPoint
	for iter.First(); iter.Valid(); iter.Next() {
		key := iter.Key()
		// Parse timestamp from key
		var ts int64
		fmt.Sscanf(string(key[len(prefix):]), "%d", &ts)
		val := new(big.Int).SetBytes(iter.Value())
		points = append(points, MetricPoint{Timestamp: ts, Value: val.String()})
	}

	// Reverse for descending order
	for i, j := 0, len(points)-1; i < j; i, j = i+1, j-1 {
		points[i], points[j] = points[j], points[i]
	}

	// Apply limit
	var nextTs int64 = -1
	if limit > 0 && len(points) > limit {
		nextTs = points[limit].Timestamp
		points = points[:limit]
	}

	return points, nextTs
}

// GetLatestMetric returns the most recent value for a metric
func (s *Store) GetLatestMetric(chainID uint32, metric, granularity string) (int64, *big.Int, bool) {
	prefix := []byte(fmt.Sprintf("m:%d:%s:%s:", chainID, metric, granularity))
	iter, err := s.db.NewIter(&pebble.IterOptions{
		LowerBound: prefix,
		UpperBound: []byte(fmt.Sprintf("m:%d:%s:%s:~", chainID, metric, granularity)),
	})
	if err != nil {
		log.Fatalf("pebble iter error: %v", err)
	}
	defer iter.Close()

	if !iter.Last() {
		return 0, nil, false
	}

	key := iter.Key()
	var ts int64
	fmt.Sscanf(string(key[len(prefix):]), "%d", &ts)
	val := new(big.Int).SetBytes(iter.Value())
	return ts, val, true
}

// --- Entities ---

func entityKey(chainID uint32, metric string, entity []byte) []byte {
	return []byte(fmt.Sprintf("e:%d:%s:%x", chainID, metric, entity))
}

// SetEntityIfNew stores entity with first_seen timestamp only if it doesn't exist.
// Returns true if entity was new.
func (s *Store) SetEntityIfNew(chainID uint32, metric string, entity []byte, ts int64) bool {
	key := entityKey(chainID, metric, entity)
	_, closer, err := s.db.Get(key)
	if err == nil {
		closer.Close()
		return false // Already exists
	}
	if err != pebble.ErrNotFound {
		log.Fatalf("pebble get error: %v", err)
	}

	// Store timestamp as big.Int bytes for consistency
	// NoSync is fine - entities are idempotent, crash just means re-insert
	val := big.NewInt(ts).Bytes()
	if err := s.db.Set(key, val, pebble.NoSync); err != nil {
		log.Fatalf("pebble set error: %v", err)
	}
	return true
}

// CountEntitiesByPeriod returns count of entities per first_seen period
func (s *Store) CountEntitiesByPeriod(chainID uint32, metric string) map[int64]*big.Int {
	prefix := []byte(fmt.Sprintf("e:%d:%s:", chainID, metric))
	iter, err := s.db.NewIter(&pebble.IterOptions{
		LowerBound: prefix,
		UpperBound: []byte(fmt.Sprintf("e:%d:%s:~", chainID, metric)),
	})
	if err != nil {
		log.Fatalf("pebble iter error: %v", err)
	}
	defer iter.Close()

	counts := make(map[int64]*big.Int)
	for iter.First(); iter.Valid(); iter.Next() {
		ts := new(big.Int).SetBytes(iter.Value()).Int64()
		if counts[ts] == nil {
			counts[ts] = big.NewInt(0)
		}
		counts[ts].Add(counts[ts], big.NewInt(1))
	}
	return counts
}

// --- Watermarks ---

func watermarkKey(chainID uint32, metric, granularity string) []byte {
	return []byte(fmt.Sprintf("w:%d:%s:%s", chainID, metric, granularity))
}

func (s *Store) SetWatermark(chainID uint32, metric, granularity string, ts int64) error {
	key := watermarkKey(chainID, metric, granularity)
	val := big.NewInt(ts).Bytes()
	return s.db.Set(key, val, pebble.Sync)
}

func (s *Store) GetWatermark(chainID uint32, metric, granularity string) (int64, bool) {
	key := watermarkKey(chainID, metric, granularity)
	val, closer, err := s.db.Get(key)
	if err == pebble.ErrNotFound {
		return 0, false
	}
	if err != nil {
		log.Fatalf("pebble get error: %v", err)
	}
	defer closer.Close()
	return new(big.Int).SetBytes(val).Int64(), true
}

// --- Batch Operations ---

type Batch struct {
	batch *pebble.Batch
	store *Store
}

func (s *Store) NewBatch() *Batch {
	return &Batch{batch: s.db.NewBatch(), store: s}
}

func (b *Batch) SetMetric(chainID uint32, metric, granularity string, ts int64, value *big.Int) {
	key := metricKey(chainID, metric, granularity, ts)
	if err := b.batch.Set(key, value.Bytes(), nil); err != nil {
		log.Fatalf("batch set error: %v", err)
	}
}

func (b *Batch) SetWatermark(chainID uint32, metric, granularity string, ts int64) {
	key := watermarkKey(chainID, metric, granularity)
	val := big.NewInt(ts).Bytes()
	if err := b.batch.Set(key, val, nil); err != nil {
		log.Fatalf("batch set error: %v", err)
	}
}

// SetEntityIfNew adds entity to batch only if it doesn't exist in main DB
// Returns true if entity was new (added to batch)
func (b *Batch) SetEntityIfNew(chainID uint32, metric string, entity []byte, ts int64) bool {
	key := entityKey(chainID, metric, entity)
	// Check main DB - if exists, skip
	_, closer, err := b.store.db.Get(key)
	if err == nil {
		closer.Close()
		return false
	}
	if err != pebble.ErrNotFound {
		log.Fatalf("pebble get error: %v", err)
	}
	// Add to batch
	val := big.NewInt(ts).Bytes()
	if err := b.batch.Set(key, val, nil); err != nil {
		log.Fatalf("batch set error: %v", err)
	}
	return true
}

func (b *Batch) Commit() error {
	return b.batch.Commit(pebble.Sync)
}

func (b *Batch) Close() error {
	return b.batch.Close()
}
