package store

import (
	"encoding/binary"
	"fmt"

	"github.com/erigontech/mdbx-go/mdbx"
	"github.com/pierrec/lz4/v4"
)

// PutContainer stores LZ4-compressed container bytes by container ID and indexes by block number.
func PutContainer(tx *mdbx.Txn, db *DB, containerID [32]byte, blockNum uint64, raw []byte) error {
	buf := make([]byte, lz4.CompressBlockBound(len(raw)))
	ht := make([]int, 1<<16)
	n, _ := lz4.CompressBlock(raw, buf, ht)
	if n == 0 {
		// Incompressible — store with a 0-byte prefix to distinguish
		compressed := make([]byte, 1+len(raw))
		compressed[0] = 0 // flag: uncompressed
		copy(compressed[1:], raw)
		if err := tx.Put(db.Containers, containerID[:], compressed, 0); err != nil {
			return err
		}
	} else {
		compressed := make([]byte, 1+n)
		compressed[0] = 1 // flag: lz4 compressed
		copy(compressed[1:], buf[:n])
		if err := tx.Put(db.Containers, containerID[:], compressed, 0); err != nil {
			return err
		}
	}
	key := BlockKey(blockNum)
	return tx.Put(db.ContainerIndex, key[:], containerID[:], 0)
}

// GetContainer retrieves and decompresses container bytes by container ID.
func GetContainer(tx *mdbx.Txn, db *DB, containerID [32]byte) ([]byte, error) {
	data, err := tx.Get(db.Containers, containerID[:])
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		return nil, fmt.Errorf("empty container")
	}
	if data[0] == 0 {
		// Uncompressed
		out := make([]byte, len(data)-1)
		copy(out, data[1:])
		return out, nil
	}
	// LZ4 compressed — need to try increasingly large buffers
	compressed := data[1:]
	for size := len(compressed) * 4; size <= 32*1024*1024; size *= 2 {
		buf := make([]byte, size)
		n, err := lz4.UncompressBlock(compressed, buf)
		if err == nil {
			return buf[:n], nil
		}
	}
	return nil, fmt.Errorf("lz4 decompress failed: output too large")
}

// GetContainerByNumber looks up the container ID from the index, then fetches and decompresses.
func GetContainerByNumber(tx *mdbx.Txn, db *DB, num uint64) ([]byte, error) {
	key := BlockKey(num)
	containerID, err := tx.Get(db.ContainerIndex, key[:])
	if err != nil {
		return nil, fmt.Errorf("container index lookup for block %d: %w", num, err)
	}
	raw, err := GetContainer(tx, db, [32]byte(containerID))
	if err != nil {
		return nil, fmt.Errorf("container fetch for block %d: %w", num, err)
	}
	return raw, nil
}

// HasContainer checks whether a container exists by ID.
func HasContainer(tx *mdbx.Txn, db *DB, containerID [32]byte) bool {
	_, err := tx.Get(db.Containers, containerID[:])
	return err == nil
}

// GetBlockByNumber retrieves a raw block by number.
// Deprecated: use GetContainerByNumber. Kept for backward compatibility.
func GetBlockByNumber(tx *mdbx.Txn, db *DB, num uint64) ([]byte, error) {
	return GetContainerByNumber(tx, db, num)
}

// CountContainersInRange counts how many entries exist in ContainerIndex
// for block numbers in [from, to] (inclusive). Uses a cursor scan.
func CountContainersInRange(tx *mdbx.Txn, db *DB, from, to uint64) (uint64, error) {
	cursor, err := tx.OpenCursor(db.ContainerIndex)
	if err != nil {
		return 0, err
	}
	defer cursor.Close()

	startKey := BlockKey(from)
	k, _, err := cursor.Get(startKey[:], nil, mdbx.SetRange)
	if err != nil {
		return 0, nil // no entries at or after from
	}

	var count uint64
	for err == nil && len(k) == 8 {
		num := binary.BigEndian.Uint64(k)
		if num > to {
			break
		}
		count++
		k, _, err = cursor.Get(nil, nil, mdbx.Next)
	}
	return count, nil
}

// PutBlockHashIndex stores a mapping from ETH block hash to container ID.
// For pre-ProposerVM blocks, block hash == container ID (redundant but harmless).
// For post-ProposerVM blocks, they differ and this index is needed for eth_getBlockByHash.
func PutBlockHashIndex(tx *mdbx.Txn, db *DB, blockHash [32]byte, containerID [32]byte) error {
	return tx.Put(db.BlockHashIndex, blockHash[:], containerID[:], 0)
}

// GetContainerByBlockHash looks up a container via ETH block hash.
func GetContainerByBlockHash(tx *mdbx.Txn, db *DB, blockHash [32]byte) ([]byte, error) {
	cid, err := tx.Get(db.BlockHashIndex, blockHash[:])
	if err != nil {
		return nil, fmt.Errorf("block hash index lookup: %w", err)
	}
	return tx.Get(db.Containers, cid)
}

// GetHeadBlock returns the last processed block number from metadata.
// Returns 0, false if no head is set.
func GetHeadBlock(tx *mdbx.Txn, db *DB) (uint64, bool) {
	val, err := tx.Get(db.Metadata, []byte("head"))
	if err != nil || len(val) < 8 {
		return 0, false
	}
	return binary.BigEndian.Uint64(val), true
}

// SetHeadBlock stores the last processed block number.
func SetHeadBlock(tx *mdbx.Txn, db *DB, num uint64) error {
	key := BlockKey(num)
	return tx.Put(db.Metadata, []byte("head"), key[:], 0)
}

// GetLatestStoredBlock returns the highest block number stored.
// Returns 0, false if no blocks stored.
func GetLatestStoredBlock(tx *mdbx.Txn, db *DB) (uint64, bool) {
	val, err := tx.Get(db.Metadata, []byte("latest_block"))
	if err != nil || len(val) < 8 {
		return 0, false
	}
	return binary.BigEndian.Uint64(val), true
}

// SetLatestStoredBlock stores the highest block number.
func SetLatestStoredBlock(tx *mdbx.Txn, db *DB, num uint64) error {
	key := BlockKey(num)
	return tx.Put(db.Metadata, []byte("latest_block"), key[:], 0)
}
