package mdbxethdb

import (
	"bytes"

	"github.com/erigontech/mdbx-go/mdbx"
)

type iterator struct {
	txn    *mdbx.Txn
	cursor *mdbx.Cursor
	prefix []byte
	key    []byte
	value  []byte
	err    error
	moved  bool // true after first call to Next
	done   bool
}

func newIterator(db *Database, prefix, start []byte) *iterator {
	it := &iterator{prefix: prefix}

	txn, err := db.env.BeginTxn(nil, mdbx.TxRO)
	if err != nil {
		it.err = err
		it.done = true
		return it
	}
	it.txn = txn

	cursor, err := txn.OpenCursor(db.dbi)
	if err != nil {
		txn.Abort()
		it.txn = nil
		it.err = err
		it.done = true
		return it
	}
	it.cursor = cursor

	// Position the cursor at the seek key (prefix + start).
	seek := append(append([]byte(nil), prefix...), start...)
	if len(seek) > 0 {
		k, v, err := cursor.Get(seek, nil, mdbx.SetRange)
		if err != nil {
			if mdbx.IsNotFound(err) {
				it.done = true
				return it
			}
			it.err = err
			it.done = true
			return it
		}
		// Check prefix match.
		if len(prefix) > 0 && !bytes.HasPrefix(k, prefix) {
			it.done = true
			return it
		}
		it.key = copyBytes(k)
		it.value = copyBytes(v)
	}
	// If seek is empty, we position on first Next() call via mdbx.First.

	return it
}

func (it *iterator) Next() bool {
	if it.done || it.err != nil {
		return false
	}

	if !it.moved {
		it.moved = true
		// If we already have a key from the constructor seek, return it.
		if it.key != nil {
			return true
		}
		// No seek was done (empty prefix+start), get the first entry.
		k, v, err := it.cursor.Get(nil, nil, mdbx.First)
		if err != nil {
			if !mdbx.IsNotFound(err) {
				it.err = err
			}
			it.done = true
			return false
		}
		if len(it.prefix) > 0 && !bytes.HasPrefix(k, it.prefix) {
			it.done = true
			return false
		}
		it.key = copyBytes(k)
		it.value = copyBytes(v)
		return true
	}

	// Advance to next entry.
	k, v, err := it.cursor.Get(nil, nil, mdbx.Next)
	if err != nil {
		if !mdbx.IsNotFound(err) {
			it.err = err
		}
		it.done = true
		it.key = nil
		it.value = nil
		return false
	}
	if len(it.prefix) > 0 && !bytes.HasPrefix(k, it.prefix) {
		it.done = true
		it.key = nil
		it.value = nil
		return false
	}
	it.key = copyBytes(k)
	it.value = copyBytes(v)
	return true
}

func (it *iterator) Key() []byte   { return it.key }
func (it *iterator) Value() []byte { return it.value }
func (it *iterator) Error() error  { return it.err }

func (it *iterator) Release() {
	if it.cursor != nil {
		it.cursor.Close()
		it.cursor = nil
	}
	if it.txn != nil {
		it.txn.Abort()
		it.txn = nil
	}
}

func copyBytes(b []byte) []byte {
	if b == nil {
		return nil
	}
	out := make([]byte, len(b))
	copy(out, b)
	return out
}
