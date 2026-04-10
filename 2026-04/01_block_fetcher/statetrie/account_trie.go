package statetrie

import (
	"errors"
	"runtime"
	"sort"

	"github.com/ava-labs/libevm/common"
	"github.com/ava-labs/libevm/core/types"
	"github.com/ava-labs/libevm/crypto"
	"github.com/ava-labs/libevm/ethdb"
	"github.com/ava-labs/libevm/rlp"
	"github.com/ava-labs/libevm/trie"
	"github.com/ava-labs/libevm/trie/trienode"
	"github.com/erigontech/mdbx-go/mdbx"
	"github.com/holiman/uint256"

	"block_fetcher/store"
)

// AccountTrie implements state.Trie for the account trie, backed by flat MDBX storage.
type AccountTrie struct {
	db              *store.DB
	stateDB         *Database // parent Database for changeset accumulation
	root            common.Hash
	dirtyAccounts   map[common.Address]*types.StateAccount
	deletedAccounts map[common.Address]bool
}

// NewAccountTrie creates a new AccountTrie for the given root.
func NewAccountTrie(db *store.DB, stateDB *Database, root common.Hash) *AccountTrie {
	return &AccountTrie{
		db:              db,
		stateDB:         stateDB,
		root:            root,
		dirtyAccounts:   make(map[common.Address]*types.StateAccount),
		deletedAccounts: make(map[common.Address]bool),
	}
}

// Copy returns a deep copy of the AccountTrie.
func (t *AccountTrie) Copy() *AccountTrie {
	cp := &AccountTrie{
		db:              t.db,
		stateDB:         t.stateDB,
		root:            t.root,
		dirtyAccounts:   make(map[common.Address]*types.StateAccount, len(t.dirtyAccounts)),
		deletedAccounts: make(map[common.Address]bool, len(t.deletedAccounts)),
	}
	for addr, acct := range t.dirtyAccounts {
		acctCopy := *acct
		cp.dirtyAccounts[addr] = &acctCopy
	}
	for addr := range t.deletedAccounts {
		cp.deletedAccounts[addr] = true
	}
	return cp
}

// GetKey returns the preimage of a hashed key. Not needed for our implementation.
func (t *AccountTrie) GetKey([]byte) []byte {
	return nil
}

// GetAccount retrieves an account by address.
func (t *AccountTrie) GetAccount(address common.Address) (*types.StateAccount, error) {
	// Check deleted first.
	if t.deletedAccounts[address] {
		return nil, nil
	}
	// Check dirty map.
	if acct, ok := t.dirtyAccounts[address]; ok {
		return acct, nil
	}
	// Read from MDBX (current or historical).
	tx, err := t.db.BeginRO()
	if err != nil {
		return nil, err
	}
	defer tx.Abort()

	var addr [20]byte
	copy(addr[:], address[:])

	var storeAcct *store.Account
	if t.stateDB != nil && t.stateDB.historicalBlock > 0 {
		storeAcct, err = store.LookupHistoricalAccount(tx, t.db, addr, t.stateDB.historicalBlock)
	} else {
		storeAcct, err = store.GetAccount(tx, t.db, addr)
	}
	if err != nil {
		return nil, err
	}
	if storeAcct == nil {
		return nil, nil
	}

	// Convert from store.Account to types.StateAccount.
	sa := &types.StateAccount{
		Nonce:    storeAcct.Nonce,
		Balance:  new(uint256.Int).SetBytes32(storeAcct.Balance[:]),
		Root:     common.Hash(storeAcct.StorageRoot),
		CodeHash: storeAcct.CodeHash[:],
	}
	return sa, nil
}

// UpdateAccount stores an account in the dirty map.
func (t *AccountTrie) UpdateAccount(address common.Address, account *types.StateAccount) error {
	delete(t.deletedAccounts, address)
	acctCopy := *account
	t.dirtyAccounts[address] = &acctCopy
	return nil
}

// DeleteAccount marks an account as deleted.
func (t *AccountTrie) DeleteAccount(address common.Address) error {
	delete(t.dirtyAccounts, address)
	t.deletedAccounts[address] = true
	return nil
}

// GetStorage delegates to a storage read. Should not normally be called on the account trie.
func (t *AccountTrie) GetStorage(addr common.Address, key []byte) ([]byte, error) {
	return nil, errors.New("GetStorage not supported on AccountTrie")
}

// UpdateStorage is not applicable for the account trie.
func (t *AccountTrie) UpdateStorage(addr common.Address, key, value []byte) error {
	return errors.New("UpdateStorage not supported on AccountTrie")
}

// DeleteStorage is not applicable for the account trie.
func (t *AccountTrie) DeleteStorage(addr common.Address, key []byte) error {
	return errors.New("DeleteStorage not supported on AccountTrie")
}

// UpdateContractCode writes contract code to MDBX.
func (t *AccountTrie) UpdateContractCode(address common.Address, codeHash common.Hash, code []byte) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	tx, err := t.db.BeginRW()
	if err != nil {
		return err
	}
	var ch [32]byte
	copy(ch[:], codeHash[:])
	if err := store.PutCode(tx, t.db, ch, code); err != nil {
		tx.Abort()
		return err
	}
	_, err = tx.Commit()
	return err
}

// accountEntry is a helper for sorting accounts by hashed key.
type accountEntry struct {
	hashedKey [32]byte
	encoded   []byte
}

// Hash computes the MPT root hash by scanning all accounts (dirty + MDBX) and
// feeding them into a StackTrie in sorted order.
func (t *AccountTrie) Hash() common.Hash {
	accounts, err := t.collectAllAccounts()
	if err != nil {
		// In production this would need better error handling, but Hash() returns
		// only a hash. Returning empty hash on error.
		return common.Hash{}
	}

	st := trie.NewStackTrie(nil)
	for _, entry := range accounts {
		if err := st.Update(entry.hashedKey[:], entry.encoded); err != nil {
			return common.Hash{}
		}
	}
	return st.Hash()
}

// Commit computes the hash, flushes dirty accounts to MDBX, and returns the root.
// It also captures old values for the changeset accumulator.
func (t *AccountTrie) Commit(collectLeaf bool) (common.Hash, *trienode.NodeSet, error) {
	root := t.Hash()

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	tx, err := t.db.BeginRW()
	if err != nil {
		return common.Hash{}, nil, err
	}

	// Collect changeset entries: read old values before writing new ones.
	var changes []store.Change
	if t.stateDB != nil {
		var zeroSlot [32]byte

		// Dirty accounts: capture old value before overwriting.
		for address := range t.dirtyAccounts {
			var addr [20]byte
			copy(addr[:], address[:])

			// Read old account from MDBX.
			var oldValue []byte
			oldAcct, err := store.GetAccount(tx, t.db, addr)
			if err != nil {
				tx.Abort()
				return common.Hash{}, nil, err
			}
			if oldAcct != nil {
				encoded := store.EncodeAccountBytes(oldAcct)
				oldValue = encoded
			}

			keyID, err := store.GetOrAssignKeyID(tx, t.db, addr, zeroSlot)
			if err != nil {
				tx.Abort()
				return common.Hash{}, nil, err
			}
			changes = append(changes, store.Change{KeyID: keyID, OldValue: oldValue})
		}

		// Deleted accounts: capture old value before deleting.
		for address := range t.deletedAccounts {
			var addr [20]byte
			copy(addr[:], address[:])

			oldAcct, err := store.GetAccount(tx, t.db, addr)
			if err != nil {
				tx.Abort()
				return common.Hash{}, nil, err
			}
			if oldAcct != nil {
				encoded := store.EncodeAccountBytes(oldAcct)
				keyID, err := store.GetOrAssignKeyID(tx, t.db, addr, zeroSlot)
				if err != nil {
					tx.Abort()
					return common.Hash{}, nil, err
				}
				changes = append(changes, store.Change{KeyID: keyID, OldValue: encoded})
			}
		}
	}

	// Write dirty accounts.
	for address, acct := range t.dirtyAccounts {
		var addr [20]byte
		copy(addr[:], address[:])
		balance := acct.Balance.Bytes32()
		var codeHash [32]byte
		copy(codeHash[:], acct.CodeHash)
		storeAcct := &store.Account{
			Nonce:       acct.Nonce,
			Balance:     balance,
			CodeHash:    codeHash,
			StorageRoot: [32]byte(acct.Root),
		}
		if err := store.PutAccount(tx, t.db, addr, storeAcct); err != nil {
			tx.Abort()
			return common.Hash{}, nil, err
		}
	}

	// Delete accounts.
	for address := range t.deletedAccounts {
		var addr [20]byte
		copy(addr[:], address[:])
		if err := tx.Del(t.db.AccountState, addr[:], nil); err != nil {
			if !mdbx.IsNotFound(err) {
				tx.Abort()
				return common.Hash{}, nil, err
			}
		}
	}

	if _, err := tx.Commit(); err != nil {
		return common.Hash{}, nil, err
	}

	// Send changes to the accumulator.
	if t.stateDB != nil && len(changes) > 0 {
		t.stateDB.AppendChanges(changes)
	}

	// Clear dirty state.
	t.dirtyAccounts = make(map[common.Address]*types.StateAccount)
	t.deletedAccounts = make(map[common.Address]bool)
	t.root = root

	return root, nil, nil
}

// NodeIterator is not supported.
func (t *AccountTrie) NodeIterator(startKey []byte) (trie.NodeIterator, error) {
	return nil, errors.New("NodeIterator not supported")
}

// Prove is not supported.
func (t *AccountTrie) Prove(key []byte, proofDb ethdb.KeyValueWriter) error {
	return errors.New("Prove not supported")
}

// collectAllAccounts reads all accounts from MDBX and merges with dirty state,
// returning them sorted by keccak256(address).
func (t *AccountTrie) collectAllAccounts() ([]accountEntry, error) {
	// Collect all accounts from MDBX via cursor scan.
	seen := make(map[common.Address]*types.StateAccount)

	tx, err := t.db.BeginRO()
	if err != nil {
		return nil, err
	}
	defer tx.Abort()

	cursor, err := tx.OpenCursor(t.db.AccountState)
	if err != nil {
		return nil, err
	}
	defer cursor.Close()

	// Scan all accounts in MDBX.
	key, val, err := cursor.Get(nil, nil, mdbx.First)
	for err == nil {
		if len(key) == 20 {
			var addr common.Address
			copy(addr[:], key)

			// Skip if deleted.
			if !t.deletedAccounts[addr] {
				storeAcct := store.DecodeAccount(val)
				sa := &types.StateAccount{
					Nonce:    storeAcct.Nonce,
					Balance:  new(uint256.Int).SetBytes32(storeAcct.Balance[:]),
					Root:     common.Hash(storeAcct.StorageRoot),
					CodeHash: storeAcct.CodeHash[:],
				}
				seen[addr] = sa
			}
		}
		key, val, err = cursor.Get(nil, nil, mdbx.Next)
	}
	if !mdbx.IsNotFound(err) && err != nil {
		return nil, err
	}

	// Override with dirty accounts.
	for addr, acct := range t.dirtyAccounts {
		seen[addr] = acct
	}

	// Remove deleted accounts.
	for addr := range t.deletedAccounts {
		delete(seen, addr)
	}

	// Build sorted entries by keccak256(address).
	entries := make([]accountEntry, 0, len(seen))
	for addr, acct := range seen {
		hashedKey := crypto.Keccak256Hash(addr[:])
		encoded, err := rlp.EncodeToBytes(acct)
		if err != nil {
			return nil, err
		}
		var hk [32]byte
		copy(hk[:], hashedKey[:])
		entries = append(entries, accountEntry{hashedKey: hk, encoded: encoded})
	}

	sort.Slice(entries, func(i, j int) bool {
		return compareBytes32(entries[i].hashedKey, entries[j].hashedKey) < 0
	})

	return entries, nil
}

// compareBytes32 compares two [32]byte values lexicographically.
func compareBytes32(a, b [32]byte) int {
	for i := 0; i < 32; i++ {
		if a[i] < b[i] {
			return -1
		}
		if a[i] > b[i] {
			return 1
		}
	}
	return 0
}
