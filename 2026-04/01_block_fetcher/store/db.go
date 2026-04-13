package store

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/erigontech/mdbx-go/mdbx"
)

const (
	TableContainers         = "Containers"
	TableContainerIndex     = "ContainerIndex"
	TableBlockHashIndex     = "BlockHashIndex"
	TableAccountState       = "AccountState"
	TableCode               = "Code"
	TableStorageState       = "StorageState"
	TableAddressIndex       = "AddressIndex"
	TableSlotIndex          = "SlotIndex"
	TableChangesets         = "Changesets"
	TableHistoryIndex       = "HistoryIndex"
	TableAccountTrie        = "AccountTrie"
	TableStorageTrie        = "StorageTrie"
	TableMetadata           = "Metadata"
	TableEthDB              = "EthDB"
	TableHashedAccountState = "HashedAccountState"
	TableHashedStorageState = "HashedStorageState"
	TableReceiptsByBlock    = "ReceiptsByBlock"
	TableTxHashIndex        = "TxHashIndex"
	TableAddressLogIndex    = "AddressLogIndex"
	TableTopicLogIndex      = "TopicLogIndex"
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
	TableReceiptsByBlock,
	TableTxHashIndex,
	TableAddressLogIndex,
	TableTopicLogIndex,
}

type DB struct {
	env      *mdbx.Env
	lockFile *os.File

	Containers         mdbx.DBI
	ContainerIndex     mdbx.DBI
	BlockHashIndex     mdbx.DBI
	AccountState       mdbx.DBI
	Code               mdbx.DBI
	StorageState       mdbx.DBI
	AddressIndex       mdbx.DBI
	SlotIndex          mdbx.DBI
	Changesets         mdbx.DBI
	HistoryIndex       mdbx.DBI
	AccountTrie        mdbx.DBI
	StorageTrie        mdbx.DBI
	Metadata           mdbx.DBI
	EthDB              mdbx.DBI
	HashedAccountState mdbx.DBI
	HashedStorageState mdbx.DBI
	ReceiptsByBlock    mdbx.DBI
	TxHashIndex        mdbx.DBI
	AddressLogIndex    mdbx.DBI
	TopicLogIndex      mdbx.DBI
}

func Open(path string) (*DB, error) {
	if err := os.MkdirAll(path, 0755); err != nil {
		return nil, err
	}

	lockPath := path + "/block_fetcher.lock"
	lockFile, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0644)
	if err != nil {
		return nil, fmt.Errorf("open db lock %s: %w", lockPath, err)
	}
	if err := syscall.Flock(int(lockFile.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		holder, readErr := os.ReadFile(lockPath)
		_ = lockFile.Close()
		if readErr == nil {
			holderInfo := strings.TrimSpace(string(holder))
			if holderInfo != "" {
				return nil, fmt.Errorf("database already locked by %s", holderInfo)
			}
		}
		return nil, fmt.Errorf("database already locked: %w", err)
	}
	lockOwner := fmt.Sprintf("pid=%d started=%s", os.Getpid(), time.Now().UTC().Format(time.RFC3339))
	if err := lockFile.Truncate(0); err != nil {
		_ = syscall.Flock(int(lockFile.Fd()), syscall.LOCK_UN)
		_ = lockFile.Close()
		return nil, fmt.Errorf("truncate db lock %s: %w", lockPath, err)
	}
	if _, err := lockFile.Seek(0, 0); err != nil {
		_ = syscall.Flock(int(lockFile.Fd()), syscall.LOCK_UN)
		_ = lockFile.Close()
		return nil, fmt.Errorf("seek db lock %s: %w", lockPath, err)
	}
	if _, err := lockFile.WriteString(lockOwner + "\n"); err != nil {
		_ = syscall.Flock(int(lockFile.Fd()), syscall.LOCK_UN)
		_ = lockFile.Close()
		return nil, fmt.Errorf("write db lock %s: %w", lockPath, err)
	}
	if err := lockFile.Sync(); err != nil {
		_ = syscall.Flock(int(lockFile.Fd()), syscall.LOCK_UN)
		_ = lockFile.Close()
		return nil, fmt.Errorf("sync db lock %s: %w", lockPath, err)
	}

	env, err := mdbx.NewEnv(mdbx.Label("store"))
	if err != nil {
		_ = syscall.Flock(int(lockFile.Fd()), syscall.LOCK_UN)
		_ = lockFile.Close()
		return nil, err
	}

	if err := env.SetOption(mdbx.OptMaxDB, 24); err != nil {
		env.Close()
		_ = syscall.Flock(int(lockFile.Fd()), syscall.LOCK_UN)
		_ = lockFile.Close()
		return nil, err
	}

	if err := env.SetGeometry(-1, -1, 1<<40, -1, -1, -1); err != nil {
		env.Close()
		_ = syscall.Flock(int(lockFile.Fd()), syscall.LOCK_UN)
		_ = lockFile.Close()
		return nil, err
	}

	flags := uint(mdbx.NoReadahead | mdbx.WriteMap | mdbx.NoStickyThreads | mdbx.SafeNoSync)
	if err := env.Open(path, flags, 0644); err != nil {
		env.Close()
		_ = syscall.Flock(int(lockFile.Fd()), syscall.LOCK_UN)
		_ = lockFile.Close()
		return nil, err
	}

	db := &DB{env: env, lockFile: lockFile}

	txn, err := env.BeginTxn(nil, mdbx.TxRW)
	if err != nil {
		env.Close()
		_ = syscall.Flock(int(lockFile.Fd()), syscall.LOCK_UN)
		_ = lockFile.Close()
		return nil, err
	}

	dbis := make([]mdbx.DBI, len(allTables))
	for i, name := range allTables {
		dbi, err := txn.OpenDBISimple(name, mdbx.Create)
		if err != nil {
			txn.Abort()
			env.Close()
			_ = syscall.Flock(int(lockFile.Fd()), syscall.LOCK_UN)
			_ = lockFile.Close()
			return nil, err
		}
		dbis[i] = dbi
	}

	if _, err := txn.Commit(); err != nil {
		env.Close()
		_ = syscall.Flock(int(lockFile.Fd()), syscall.LOCK_UN)
		_ = lockFile.Close()
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
	db.ReceiptsByBlock = dbis[16]
	db.TxHashIndex = dbis[17]
	db.AddressLogIndex = dbis[18]
	db.TopicLogIndex = dbis[19]

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
	if db.lockFile != nil {
		pid := strconv.Itoa(os.Getpid())
		_ = db.lockFile.Truncate(0)
		_, _ = db.lockFile.Seek(0, 0)
		_, _ = db.lockFile.WriteString("released by pid=" + pid + "\n")
		_ = db.lockFile.Sync()
		_ = syscall.Flock(int(db.lockFile.Fd()), syscall.LOCK_UN)
		_ = db.lockFile.Close()
		db.lockFile = nil
	}
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
		db.ReceiptsByBlock, db.TxHashIndex,
		db.AddressLogIndex, db.TopicLogIndex,
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
