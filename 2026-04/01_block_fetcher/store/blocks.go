package store

import (
	"encoding/binary"
	"fmt"

	"github.com/erigontech/mdbx-go/mdbx"
)

// zstdEncoder and zstdDecoder are declared in history.go

// PutContainer stores ZSTD-compressed container bytes by container ID and indexes by block number.
func PutContainer(tx *mdbx.Txn, db *DB, containerID [32]byte, blockNum uint64, raw []byte) error {
	compressed := zstdEncoder.EncodeAll(raw, nil)
	if err := tx.Put(db.Containers, containerID[:], compressed, 0); err != nil {
		return err
	}
	key := BlockKey(blockNum)
	return tx.Put(db.ContainerIndex, key[:], containerID[:], 0)
}

// GetContainer retrieves and decompresses container bytes by container ID.
func GetContainer(tx *mdbx.Txn, db *DB, containerID [32]byte) ([]byte, error) {
	compressed, err := tx.Get(db.Containers, containerID[:])
	if err != nil {
		return nil, err
	}
	return zstdDecoder.DecodeAll(compressed, nil)
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
