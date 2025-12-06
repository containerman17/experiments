package storage

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/cockroachdb/pebble/v2"
)

const (
	blockKeyPrefix = "block:"
	blockKeyFormat = "block:%d:%020d" // block:{chainID}:{blockNum padded to 20 digits}
)

type Storage struct {
	db *pebble.DB
}

func NewStorage(path string) (*Storage, error) {
	db, err := pebble.Open(path, &pebble.Options{})
	if err != nil {
		return nil, fmt.Errorf("failed to open pebble db: %w", err)
	}
	return &Storage{db: db}, nil
}

func (s *Storage) Close() error {
	return s.db.Close()
}

func blockKey(chainID, blockNum uint64) []byte {
	return []byte(fmt.Sprintf(blockKeyFormat, chainID, blockNum))
}

func parseBlockKey(key []byte) (chainID, blockNum uint64, ok bool) {
	parts := strings.Split(string(key), ":")
	if len(parts) != 3 || parts[0] != "block" {
		return 0, 0, false
	}
	var err error
	chainID, err = strconv.ParseUint(parts[1], 10, 64)
	if err != nil {
		return 0, 0, false
	}
	blockNum, err = strconv.ParseUint(parts[2], 10, 64)
	if err != nil {
		return 0, 0, false
	}
	return chainID, blockNum, true
}

// SaveBlock stores a block's JSON data
func (s *Storage) SaveBlock(chainID, blockNum uint64, data []byte) error {
	return s.db.Set(blockKey(chainID, blockNum), data, pebble.Sync)
}

// GetBlock retrieves a single block's data
func (s *Storage) GetBlock(chainID, blockNum uint64) ([]byte, error) {
	data, closer, err := s.db.Get(blockKey(chainID, blockNum))
	if err != nil {
		return nil, err
	}
	result := make([]byte, len(data))
	copy(result, data)
	closer.Close()
	return result, nil
}

// GetBatch retrieves count consecutive blocks starting from startBlock
// Returns nil entries for missing blocks
func (s *Storage) GetBatch(chainID, startBlock uint64, count int) ([][]byte, error) {
	result := make([][]byte, count)

	startKey := blockKey(chainID, startBlock)
	endKey := blockKey(chainID, startBlock+uint64(count))

	iter, err := s.db.NewIter(&pebble.IterOptions{
		LowerBound: startKey,
		UpperBound: endKey,
	})
	if err != nil {
		return nil, err
	}
	defer iter.Close()

	for iter.First(); iter.Valid(); iter.Next() {
		cid, bn, ok := parseBlockKey(iter.Key())
		if !ok || cid != chainID {
			continue
		}
		idx := int(bn - startBlock)
		if idx >= 0 && idx < count {
			val := iter.Value()
			result[idx] = make([]byte, len(val))
			copy(result[idx], val)
		}
	}

	return result, iter.Error()
}

// HasConsecutiveBlocks checks if count consecutive blocks exist starting from startBlock
func (s *Storage) HasConsecutiveBlocks(chainID, startBlock uint64, count int) (bool, error) {
	for i := 0; i < count; i++ {
		_, closer, err := s.db.Get(blockKey(chainID, startBlock+uint64(i)))
		if err == pebble.ErrNotFound {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		closer.Close()
	}
	return true, nil
}

// DeleteBatch deletes count consecutive blocks starting from startBlock
func (s *Storage) DeleteBatch(chainID, startBlock uint64, count int) error {
	batch := s.db.NewBatch()
	defer batch.Close()

	for i := 0; i < count; i++ {
		if err := batch.Delete(blockKey(chainID, startBlock+uint64(i)), nil); err != nil {
			return err
		}
	}

	return batch.Commit(pebble.Sync)
}

// FirstBlock returns the lowest block number stored for a chain
func (s *Storage) FirstBlock(chainID uint64) (uint64, bool) {
	prefix := []byte(fmt.Sprintf("block:%d:", chainID))

	iter, err := s.db.NewIter(&pebble.IterOptions{
		LowerBound: prefix,
		UpperBound: []byte(fmt.Sprintf("block:%d;", chainID)), // ; is after : in ASCII
	})
	if err != nil {
		return 0, false
	}
	defer iter.Close()

	if !iter.First() {
		return 0, false
	}

	_, blockNum, ok := parseBlockKey(iter.Key())
	return blockNum, ok
}

// LatestBlock returns the highest block number stored for a chain
func (s *Storage) LatestBlock(chainID uint64) (uint64, bool) {
	prefix := []byte(fmt.Sprintf("block:%d:", chainID))

	iter, err := s.db.NewIter(&pebble.IterOptions{
		LowerBound: prefix,
		UpperBound: []byte(fmt.Sprintf("block:%d;", chainID)),
	})
	if err != nil {
		return 0, false
	}
	defer iter.Close()

	if !iter.Last() {
		return 0, false
	}

	_, blockNum, ok := parseBlockKey(iter.Key())
	return blockNum, ok
}

// BlockCount returns approximate count of blocks stored for a chain
func (s *Storage) BlockCount(chainID uint64) int {
	first, hasFirst := s.FirstBlock(chainID)
	if !hasFirst {
		return 0
	}
	last, hasLast := s.LatestBlock(chainID)
	if !hasLast {
		return 0
	}
	// This is approximate - assumes no gaps
	return int(last - first + 1)
}

// GetBlockRange reads all blocks from startBlock to endBlock (inclusive) in one iterator pass.
// Returns a map of blockNum -> data. Much faster than multiple GetBatch calls.
func (s *Storage) GetBlockRange(chainID, startBlock, endBlock uint64) (map[uint64][]byte, error) {
	result := make(map[uint64][]byte)

	startKey := blockKey(chainID, startBlock)
	endKey := blockKey(chainID, endBlock+1)

	iter, err := s.db.NewIter(&pebble.IterOptions{
		LowerBound: startKey,
		UpperBound: endKey,
	})
	if err != nil {
		return nil, err
	}
	defer iter.Close()

	for iter.First(); iter.Valid(); iter.Next() {
		cid, bn, ok := parseBlockKey(iter.Key())
		if !ok || cid != chainID {
			continue
		}
		val := iter.Value()
		data := make([]byte, len(val))
		copy(data, val)
		result[bn] = data
	}

	return result, iter.Error()
}

// DeleteBlockRange deletes all blocks from startBlock to endBlock (inclusive)
func (s *Storage) DeleteBlockRange(chainID, startBlock, endBlock uint64) error {
	startKey := blockKey(chainID, startBlock)
	endKey := blockKey(chainID, endBlock+1)
	return s.db.DeleteRange(startKey, endKey, pebble.Sync)
}
