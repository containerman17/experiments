package statetrie

import (
	"github.com/ava-labs/libevm/common"
	"github.com/ava-labs/libevm/core/rawdb"
	"github.com/ava-labs/libevm/core/state"
	"github.com/ava-labs/libevm/core/types"
	"github.com/ava-labs/libevm/ethdb"
	"github.com/ava-labs/libevm/triedb"

	"block_fetcher/store"
	mdbxethdb "block_fetcher/store/ethdb"
)

// Compile-time check that Database implements state.Database.
var _ state.Database = (*Database)(nil)

// Database implements state.Database backed by flat MDBX storage.
type Database struct {
	mdbxDB *store.DB
	ethKV  ethdb.KeyValueStore
	trieDB *triedb.Database
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

// OpenTrie opens the main account trie for the given state root.
func (db *Database) OpenTrie(root common.Hash) (state.Trie, error) {
	return NewAccountTrie(db.mdbxDB, root), nil
}

// OpenStorageTrie opens the storage trie of an account.
func (db *Database) OpenStorageTrie(stateRoot common.Hash, address common.Address, root common.Hash, self state.Trie) (state.Trie, error) {
	return NewStorageTrie(db.mdbxDB, address, root), nil
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
	tx, err := db.mdbxDB.BeginRO()
	if err != nil {
		return nil, err
	}
	defer tx.Abort()

	var ch [32]byte
	copy(ch[:], codeHash[:])
	code, err := store.GetCode(tx, db.mdbxDB, ch)
	if err != nil {
		return nil, err
	}
	return code, nil
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
