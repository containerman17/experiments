package mdbxethdb

import "github.com/ava-labs/libevm/ethdb"

type keyvalue struct {
	key    []byte
	value  []byte
	delete bool
}

type batch struct {
	db     *Database
	writes []keyvalue
	size   int
}

func newBatch(db *Database) *batch {
	return &batch{db: db}
}

func (b *batch) Put(key, value []byte) error {
	b.writes = append(b.writes, keyvalue{
		key:   append([]byte(nil), key...),
		value: append([]byte(nil), value...),
	})
	b.size += len(key) + len(value)
	return nil
}

func (b *batch) Delete(key []byte) error {
	b.writes = append(b.writes, keyvalue{
		key:    append([]byte(nil), key...),
		delete: true,
	})
	b.size += len(key)
	return nil
}

func (b *batch) ValueSize() int {
	return b.size
}

func (b *batch) Write() error {
	txn, err := b.db.env.BeginTxn(nil, 0) // TxRW = 0
	if err != nil {
		return err
	}
	for _, kv := range b.writes {
		if kv.delete {
			if err := txn.Del(b.db.dbi, kv.key, nil); err != nil {
				if !isNotFound(err) {
					txn.Abort()
					return err
				}
			}
		} else {
			if err := txn.Put(b.db.dbi, kv.key, kv.value, 0); err != nil {
				txn.Abort()
				return err
			}
		}
	}
	_, err = txn.Commit()
	return err
}

func (b *batch) Reset() {
	b.writes = b.writes[:0]
	b.size = 0
}

func (b *batch) Replay(w ethdb.KeyValueWriter) error {
	for _, kv := range b.writes {
		if kv.delete {
			if err := w.Delete(kv.key); err != nil {
				return err
			}
		} else {
			if err := w.Put(kv.key, kv.value); err != nil {
				return err
			}
		}
	}
	return nil
}
