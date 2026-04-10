package store

import (
	"encoding/binary"

	"github.com/erigontech/mdbx-go/mdbx"
)

// PutBlock stores a raw block by number and indexes it by hash.
func PutBlock(tx *mdbx.Txn, db *DB, num uint64, hash [32]byte, raw []byte) error {
	key := BlockKey(num)
	if err := tx.Put(db.Blocks, key[:], raw, 0); err != nil {
		return err
	}
	return tx.Put(db.BlockIndex, hash[:], key[:], 0)
}

// GetBlockByNumber retrieves a raw block by number.
func GetBlockByNumber(tx *mdbx.Txn, db *DB, num uint64) ([]byte, error) {
	key := BlockKey(num)
	return tx.Get(db.Blocks, key[:])
}

// GetBlockByHash retrieves a raw block by hash.
func GetBlockByHash(tx *mdbx.Txn, db *DB, hash [32]byte) ([]byte, error) {
	numBytes, err := tx.Get(db.BlockIndex, hash[:])
	if err != nil {
		return nil, err
	}
	return tx.Get(db.Blocks, numBytes)
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

// GetLatestStoredBlock returns the highest block number stored in the Blocks table.
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
