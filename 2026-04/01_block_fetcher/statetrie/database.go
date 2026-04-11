package statetrie

import (
	"fmt"
	"runtime"
	"sync"

	"github.com/ava-labs/libevm/common"
	"github.com/ava-labs/libevm/core/rawdb"
	"github.com/ava-labs/libevm/core/state"
	"github.com/ava-labs/libevm/core/types"
	"github.com/ava-labs/libevm/ethdb"
	"github.com/ava-labs/libevm/triedb"

	"block_fetcher/store"
	mdbxethdb "block_fetcher/store/ethdb"

	"github.com/erigontech/mdbx-go/mdbx"
)

// Compile-time check that Database implements state.Database.
var _ state.Database = (*Database)(nil)

// Database implements state.Database backed by flat MDBX storage.
type Database struct {
	mdbxDB *store.DB
	ethKV  ethdb.KeyValueStore
	trieDB *triedb.Database

	// Historical mode: if > 0, reads return state at this block instead of head.
	historicalBlock uint64

	// SkipHash: when true, Hash() writes to overlay but skips trie hash.
	SkipHash bool

	// Batch overlay: when set, all reads/writes go through here instead of MDBX.
	Overlay *BatchOverlay

	// Shared RO transaction for batch mode — avoids opening/closing per read.
	// Set by BeginBatchRO(), cleared by EndBatchRO().
	batchROTx *mdbx.Txn

	// CurrentBlock is set by the executor before each block so tries know
	// which block they are processing (for per-block changeset grouping).
	CurrentBlock uint64

	// Changeset accumulator: both AccountTrie and StorageTrie append here during Commit.
	mu         sync.Mutex
	changes    []store.Change
	rawChanges []RawChange
}

// NewDatabase creates a new state Database backed by the given MDBX store.
func NewDatabase(mdbxDB *store.DB) *Database {
	ethKV := mdbxethdb.New(mdbxDB.Env(), mdbxDB.EthDB)
	ethDB := rawdb.NewDatabase(ethKV)
	tdb := triedb.NewDatabase(ethDB, nil)
	return &Database{
		mdbxDB: mdbxDB,
		ethKV:  ethKV,
		trieDB: tdb,
	}
}

// NewHistoricalDatabase creates a read-only state Database that returns state
// as of a specific block number. Used for eth_call at past blocks.
func NewHistoricalDatabase(mdbxDB *store.DB, blockNum uint64) *Database {
	db := NewDatabase(mdbxDB)
	db.historicalBlock = blockNum
	return db
}

// OpenTrie opens the main account trie for the given state root.
func (db *Database) OpenTrie(root common.Hash) (state.Trie, error) {
	return NewAccountTrie(db.mdbxDB, db, root), nil
}

// OpenStorageTrie opens the storage trie of an account.
func (db *Database) OpenStorageTrie(stateRoot common.Hash, address common.Address, root common.Hash, self state.Trie) (state.Trie, error) {
	return NewStorageTrie(db.mdbxDB, db, address, root), nil
}

// CopyTrie returns an independent copy of the given trie.
func (db *Database) CopyTrie(t state.Trie) state.Trie {
	switch tt := t.(type) {
	case *AccountTrie:
		return tt.Copy()
	case *StorageTrie:
		return tt.Copy()
	default:
		panic("statetrie.Database.CopyTrie: unknown trie type")
	}
}

// ContractCode retrieves contract bytecode by address and code hash.
func (db *Database) ContractCode(addr common.Address, codeHash common.Hash) ([]byte, error) {
	if codeHash == types.EmptyCodeHash {
		return nil, nil
	}
	var ch [32]byte
	copy(ch[:], codeHash[:])

	tx, done, err := db.GetROTx()
	if err != nil {
		return nil, err
	}
	defer done()

	if db.Overlay != nil {
		return db.Overlay.GetCode(tx, db.mdbxDB, ch)
	}
	return store.GetCode(tx, db.mdbxDB, ch)
}

// ContractCodeSize retrieves the size of a contract's bytecode.
func (db *Database) ContractCodeSize(addr common.Address, codeHash common.Hash) (int, error) {
	code, err := db.ContractCode(addr, codeHash)
	if err != nil {
		return 0, err
	}
	return len(code), nil
}

// DiskDB returns the underlying key-value disk database.
func (db *Database) DiskDB() ethdb.KeyValueStore {
	return db.ethKV
}

// TrieDB returns the underlying trie database.
func (db *Database) TrieDB() *triedb.Database {
	return db.trieDB
}

// BeginBatchRO opens a shared RO transaction for the batch.
// All trie reads use this instead of opening per-call transactions.
func (db *Database) BeginBatchRO() error {
	runtime.LockOSThread()
	tx, err := db.mdbxDB.BeginRO()
	if err != nil {
		runtime.UnlockOSThread()
		return err
	}
	db.batchROTx = tx
	return nil
}

// EndBatchRO closes the shared RO transaction.
func (db *Database) EndBatchRO() {
	if db.batchROTx != nil {
		db.batchROTx.Abort()
		db.batchROTx = nil
		runtime.UnlockOSThread()
	}
}

// GetROTx returns the shared batch RO transaction if available,
// otherwise opens a fresh one. Caller must call doneFunc when done.
func (db *Database) GetROTx() (tx *mdbx.Txn, doneFunc func(), err error) {
	if db.batchROTx != nil {
		return db.batchROTx, func() {}, nil // shared, don't abort
	}
	tx, err = db.mdbxDB.BeginRO()
	if err != nil {
		return nil, nil, err
	}
	return tx, func() { tx.Abort() }, nil
}

// AppendChanges adds changeset entries from a trie Commit. Thread-safe.
// Used in non-overlay mode (incremental hash path).
func (db *Database) AppendChanges(changes []store.Change) {
	if len(changes) == 0 {
		return
	}
	db.mu.Lock()
	db.changes = append(db.changes, changes...)
	db.mu.Unlock()
}

// AppendRawChanges adds raw changeset entries (without keyIDs). Thread-safe.
// Used in overlay/batch mode where keyIDs are assigned during Flush.
func (db *Database) AppendRawChanges(changes []RawChange) {
	if len(changes) == 0 {
		return
	}
	db.mu.Lock()
	db.rawChanges = append(db.rawChanges, changes...)
	db.mu.Unlock()
}

// FlushChangeset writes the accumulated changeset and history index for the given block,
// then clears the accumulator. Must be called after sdb.Commit().
// In overlay mode, raw changes are sent to the overlay for deferred keyID assignment.
func (db *Database) FlushChangeset(blockNum uint64) error {
	// Overlay mode: send raw changes to the overlay, no MDBX writes.
	if db.Overlay != nil {
		db.mu.Lock()
		rawChanges := db.rawChanges
		db.rawChanges = nil
		// Also drain any store.Change entries (shouldn't happen in overlay mode, but be safe).
		db.changes = nil
		db.mu.Unlock()

		if len(rawChanges) > 0 {
			db.Overlay.AddRawChangeset(blockNum, rawChanges)
		}
		return nil
	}

	// Non-overlay mode: write directly to MDBX.
	db.mu.Lock()
	changes := db.changes
	db.changes = nil
	db.mu.Unlock()

	if len(changes) == 0 {
		return nil
	}

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	tx, err := db.mdbxDB.BeginRW()
	if err != nil {
		return fmt.Errorf("begin RW for changeset: %w", err)
	}

	if err := store.WriteChangeset(tx, db.mdbxDB, blockNum, changes); err != nil {
		tx.Abort()
		return fmt.Errorf("write changeset: %w", err)
	}

	for _, c := range changes {
		if err := store.UpdateHistoryIndex(tx, db.mdbxDB, c.KeyID, blockNum); err != nil {
			tx.Abort()
			return fmt.Errorf("update history index: %w", err)
		}
	}

	if _, err := tx.Commit(); err != nil {
		return fmt.Errorf("commit changeset: %w", err)
	}

	return nil
}

// MdbxDB returns the underlying MDBX store for direct access.
func (db *Database) MdbxDB() *store.DB {
	return db.mdbxDB
}
