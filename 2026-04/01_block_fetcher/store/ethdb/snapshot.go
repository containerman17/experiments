package mdbxethdb

import (
	"github.com/erigontech/mdbx-go/mdbx"
)

type snapshot struct {
	txn *mdbx.Txn
	dbi mdbx.DBI
}

func newSnapshot(db *Database) (*snapshot, error) {
	txn, err := db.env.BeginTxn(nil, mdbx.TxRO)
	if err != nil {
		return nil, err
	}
	return &snapshot{txn: txn, dbi: db.dbi}, nil
}

func (s *snapshot) Has(key []byte) (bool, error) {
	_, err := s.txn.Get(s.dbi, key)
	if err != nil {
		if mdbx.IsNotFound(err) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

func (s *snapshot) Get(key []byte) ([]byte, error) {
	val, err := s.txn.Get(s.dbi, key)
	if err != nil {
		if mdbx.IsNotFound(err) {
			return nil, errNotFound
		}
		return nil, err
	}
	out := make([]byte, len(val))
	copy(out, val)
	return out, nil
}

func (s *snapshot) Release() {
	if s.txn != nil {
		s.txn.Abort()
		s.txn = nil
	}
}
