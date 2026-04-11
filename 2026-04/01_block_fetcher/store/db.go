package store

import (
	"os"

	"github.com/erigontech/mdbx-go/mdbx"
)

const (
	TableContainers      = "Containers"
	TableContainerIndex  = "ContainerIndex"
	TableBlockHashIndex  = "BlockHashIndex"
	TableAccountState    = "AccountState"
	TableCode         = "Code"
	TableStorageState = "StorageState"
	TableAddressIndex = "AddressIndex"
	TableSlotIndex    = "SlotIndex"
	TableChangesets   = "Changesets"
	TableHistoryIndex = "HistoryIndex"
	TableAccountTrie  = "AccountTrie"
	TableStorageTrie  = "StorageTrie"
	TableMetadata           = "Metadata"
	TableEthDB              = "EthDB"
	TableHashedAccountState = "HashedAccountState"
	TableHashedStorageState = "HashedStorageState"
)

var allTables = []string{
	TableContainers,
	TableContainerIndex,
	TableBlockHashIndex,
	TableAccountState,
	TableCode,
	TableStorageState,
	TableAddressIndex,
	TableSlotIndex,
	TableChangesets,
	TableHistoryIndex,
	TableAccountTrie,
	TableStorageTrie,
	TableMetadata,
	TableEthDB,
	TableHashedAccountState,
	TableHashedStorageState,
}

type DB struct {
	env *mdbx.Env

	Containers     mdbx.DBI
	ContainerIndex mdbx.DBI
	BlockHashIndex mdbx.DBI
	AccountState   mdbx.DBI
	Code         mdbx.DBI
	StorageState mdbx.DBI
	AddressIndex mdbx.DBI
	SlotIndex    mdbx.DBI
	Changesets   mdbx.DBI
	HistoryIndex mdbx.DBI
	AccountTrie  mdbx.DBI
	StorageTrie  mdbx.DBI
	Metadata           mdbx.DBI
	EthDB              mdbx.DBI
	HashedAccountState mdbx.DBI
	HashedStorageState mdbx.DBI
}

func Open(path string) (*DB, error) {
	if err := os.MkdirAll(path, 0755); err != nil {
		return nil, err
	}

	env, err := mdbx.NewEnv(mdbx.Label("store"))
	if err != nil {
		return nil, err
	}

	if err := env.SetOption(mdbx.OptMaxDB, 20); err != nil {
		env.Close()
		return nil, err
	}

	if err := env.SetGeometry(-1, -1, 1<<40, -1, -1, -1); err != nil {
		env.Close()
		return nil, err
	}

	flags := uint(mdbx.NoReadahead | mdbx.WriteMap | mdbx.NoStickyThreads)
	if err := env.Open(path, flags, 0644); err != nil {
		env.Close()
		return nil, err
	}

	db := &DB{env: env}

	txn, err := env.BeginTxn(nil, mdbx.TxRW)
	if err != nil {
		env.Close()
		return nil, err
	}

	dbis := make([]mdbx.DBI, len(allTables))
	for i, name := range allTables {
		dbi, err := txn.OpenDBISimple(name, mdbx.Create)
		if err != nil {
			txn.Abort()
			env.Close()
			return nil, err
		}
		dbis[i] = dbi
	}

	if _, err := txn.Commit(); err != nil {
		env.Close()
		return nil, err
	}

	db.Containers = dbis[0]
	db.ContainerIndex = dbis[1]
	db.BlockHashIndex = dbis[2]
	db.AccountState = dbis[3]
	db.Code = dbis[4]
	db.StorageState = dbis[5]
	db.AddressIndex = dbis[6]
	db.SlotIndex = dbis[7]
	db.Changesets = dbis[8]
	db.HistoryIndex = dbis[9]
	db.AccountTrie = dbis[10]
	db.StorageTrie = dbis[11]
	db.Metadata = dbis[12]
	db.EthDB = dbis[13]
	db.HashedAccountState = dbis[14]
	db.HashedStorageState = dbis[15]

	return db, nil
}

func (db *DB) BeginRO() (*mdbx.Txn, error) {
	return db.env.BeginTxn(nil, mdbx.TxRO)
}

func (db *DB) BeginRW() (*mdbx.Txn, error) {
	return db.env.BeginTxn(nil, mdbx.TxRW)
}

func (db *DB) Env() *mdbx.Env {
	return db.env
}

func (db *DB) Close() {
	db.env.Close()
}

// ClearState drops all data except containers and container index.
// Used to re-execute from genesis without refetching containers.
func (db *DB) ClearState() error {
	tx, err := db.BeginRW()
	if err != nil {
		return err
	}
	tables := []mdbx.DBI{
		db.AccountState, db.Code, db.StorageState,
		db.AddressIndex, db.SlotIndex,
		db.Changesets, db.HistoryIndex,
		db.AccountTrie, db.StorageTrie,
		db.Metadata, db.EthDB,
		db.HashedAccountState, db.HashedStorageState,
	}
	for _, dbi := range tables {
		if err := tx.Drop(dbi, false); err != nil {
			tx.Abort()
			return err
		}
	}
	_, err = tx.Commit()
	return err
}
