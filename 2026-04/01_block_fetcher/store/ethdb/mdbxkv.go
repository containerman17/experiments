package mdbxethdb

import (
	"errors"

	"github.com/ava-labs/libevm/ethdb"
	"github.com/erigontech/mdbx-go/mdbx"
)

var errNotFound = errors.New("not found")

// Compile-time interface check.
var _ ethdb.KeyValueStore = (*Database)(nil)

// Database implements ethdb.KeyValueStore backed by an MDBX named database.
type Database struct {
	env *mdbx.Env
	dbi mdbx.DBI
}

// New creates a new Database using the given MDBX environment and DBI handle.
func New(env *mdbx.Env, dbi mdbx.DBI) *Database {
	return &Database{env: env, dbi: dbi}
}

func (db *Database) Has(key []byte) (bool, error) {
	txn, err := db.env.BeginTxn(nil, mdbx.TxRO)
	if err != nil {
		return false, err
	}
	defer txn.Abort()

	_, err = txn.Get(db.dbi, key)
	if err != nil {
		if mdbx.IsNotFound(err) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

func (db *Database) Get(key []byte) ([]byte, error) {
	txn, err := db.env.BeginTxn(nil, mdbx.TxRO)
	if err != nil {
		return nil, err
	}
	defer txn.Abort()

	val, err := txn.Get(db.dbi, key)
	if err != nil {
		if mdbx.IsNotFound(err) {
			return nil, errNotFound
		}
		return nil, err
	}
	// Copy: val points to mmap'd memory only valid during txn.
	out := make([]byte, len(val))
	copy(out, val)
	return out, nil
}

func (db *Database) Put(key []byte, value []byte) error {
	txn, err := db.env.BeginTxn(nil, mdbx.TxRW)
	if err != nil {
		return err
	}
	if err := txn.Put(db.dbi, key, value, 0); err != nil {
		txn.Abort()
		return err
	}
	_, err = txn.Commit()
	return err
}

func (db *Database) Delete(key []byte) error {
	txn, err := db.env.BeginTxn(nil, mdbx.TxRW)
	if err != nil {
		return err
	}
	if err := txn.Del(db.dbi, key, nil); err != nil {
		if mdbx.IsNotFound(err) {
			// Key already absent — not an error.
			txn.Abort()
			return nil
		}
		txn.Abort()
		return err
	}
	_, err = txn.Commit()
	return err
}

func (db *Database) Stat(property string) (string, error) {
	return "", errors.New("not supported")
}

func (db *Database) Compact(start []byte, limit []byte) error {
	return nil
}

func (db *Database) Close() error {
	return nil
}

func (db *Database) NewBatch() ethdb.Batch {
	return newBatch(db)
}

func (db *Database) NewBatchWithSize(size int) ethdb.Batch {
	return newBatch(db)
}

func (db *Database) NewIterator(prefix []byte, start []byte) ethdb.Iterator {
	return newIterator(db, prefix, start)
}

func (db *Database) NewSnapshot() (ethdb.Snapshot, error) {
	return newSnapshot(db)
}
