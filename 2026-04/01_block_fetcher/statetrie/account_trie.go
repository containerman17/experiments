package statetrie

import (
	"errors"
	"runtime"

	"github.com/ava-labs/libevm/common"
	"github.com/ava-labs/libevm/core/types"
	"github.com/ava-labs/libevm/ethdb"

	ccustomtypes "github.com/ava-labs/avalanchego/graft/coreth/plugin/evm/customtypes"
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

// getROTx returns a shared batch RO tx if available, otherwise opens a fresh one.
func (t *AccountTrie) getROTx() (*mdbx.Txn, func(), error) {
	if t.stateDB != nil {
		return t.stateDB.GetROTx()
	}
	tx, err := t.db.BeginRO()
	if err != nil {
		return nil, nil, err
	}
	return tx, func() { tx.Abort() }, nil
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
	// Read from overlay (if in batch mode) or MDBX.
	tx, done, err := t.getROTx()
	if err != nil {
		return nil, err
	}
	defer done()

	var addr [20]byte
	copy(addr[:], address[:])

	var storeAcct *store.Account
	if t.stateDB != nil && t.stateDB.historicalBlock > 0 {
		storeAcct, err = store.LookupHistoricalAccount(tx, t.db, addr, t.stateDB.historicalBlock)
	} else if t.stateDB != nil && t.stateDB.Overlay != nil {
		storeAcct, err = t.stateDB.Overlay.GetAccount(tx, t.db, addr)
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

// UpdateContractCode writes contract code to overlay (if active) or MDBX.
func (t *AccountTrie) UpdateContractCode(address common.Address, codeHash common.Hash, code []byte) error {
	var ch [32]byte
	copy(ch[:], codeHash[:])

	// Overlay mode: write to overlay, no MDBX transaction.
	if t.stateDB != nil && t.stateDB.Overlay != nil {
		t.stateDB.Overlay.PutCode(ch, code)
		return nil
	}

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	tx, err := t.db.BeginRW()
	if err != nil {
		return err
	}
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

// Hash flushes dirty account state to the overlay (or MDBX in non-overlay mode).
// It does NOT compute the trie hash — that's done once per batch by
// ComputeIncrementalStateRoot. Returns a dummy hash; callers must not use
// the return value for verification.
func (t *AccountTrie) Hash() common.Hash {
	if len(t.dirtyAccounts) == 0 && len(t.deletedAccounts) == 0 {
		return t.root
	}

	if err := t.flushStateOnly(); err != nil {
		return common.Hash{}
	}
	return common.Hash{} // dummy — real root computed at batch boundary
}

// flushStateOnly writes dirty account state to the overlay and captures
// raw changesets (keyIDs assigned later during Flush).
func (t *AccountTrie) flushStateOnly() error {
	overlay := t.stateDB.Overlay
	// We need a RO transaction to read old values for changeset capture.
	tx, err := t.db.BeginRO()
	if err != nil {
		return err
	}
	defer tx.Abort()

	var rawChanges []RawChange
	acctSlot := store.AccountSentinelSlot

	for address, acct := range t.dirtyAccounts {
		var addr [20]byte
		copy(addr[:], address[:])

		// Read old value from overlay→MDBX BEFORE writing new value.
		if t.stateDB != nil {
			oldAcct, err := overlay.GetAccount(tx, t.db, addr)
			if err != nil {
				return err
			}
			var oldValue []byte
			if oldAcct != nil {
				oldValue = store.EncodeAccountBytes(oldAcct)
			}
			rawChanges = append(rawChanges, RawChange{Addr: addr, Slot: acctSlot, OldValue: oldValue})
		}

		// Write new value to overlay.
		// If acct.Root is the dummy zero (StorageTrie had dirty slots), preserve
		// the existing storage root from overlay/MDBX. The real root is computed
		// at batch end by ComputeIncrementalStateRoot.
		// If acct.Root is non-zero, it's the real root from StorageTrie.Hash()
		// (no dirty slots = unchanged storage), so use it as-is.
		storageRoot := [32]byte(acct.Root)
		if storageRoot == [32]byte{} {
			storageRoot = store.EmptyRootHash
			if existingAcct, _ := overlay.GetAccount(tx, t.db, addr); existingAcct != nil {
				storageRoot = existingAcct.StorageRoot
			}
		}
		balance := acct.Balance.Bytes32()
		var codeHash [32]byte
		copy(codeHash[:], acct.CodeHash)
		isMultiCoin := ccustomtypes.IsAccountMultiCoin(acct)
		storeAcct := &store.Account{
			Nonce: acct.Nonce, Balance: balance,
			CodeHash: codeHash, StorageRoot: storageRoot,
			IsMultiCoin: isMultiCoin,
		}
		encoded := store.EncodeAccountBytes(storeAcct)
		overlay.PutAccount(addr, encoded)
	}

	for address := range t.deletedAccounts {
		var addr [20]byte
		copy(addr[:], address[:])

		// Read old value from overlay→MDBX BEFORE deleting.
		if t.stateDB != nil {
			oldAcct, err := overlay.GetAccount(tx, t.db, addr)
			if err != nil {
				return err
			}
			if oldAcct != nil {
				rawChanges = append(rawChanges, RawChange{
					Addr: addr, Slot: acctSlot,
					OldValue: store.EncodeAccountBytes(oldAcct),
				})
			}
		}

		overlay.DeleteAccount(addr)
	}

	if t.stateDB != nil && len(rawChanges) > 0 {
		t.stateDB.AppendRawChanges(rawChanges)
	}
	return nil
}

// Commit returns the cached root from Hash() and clears dirty state.
// All actual work (writing state, changeset collection, branch node updates)
// is done in Hash().
func (t *AccountTrie) Commit(collectLeaf bool) (common.Hash, *trienode.NodeSet, error) {
	// Ensure Hash() has been called (state.StateDB always calls Hash() before Commit()).
	root := t.Hash()

	// Clear dirty state.
	t.dirtyAccounts = make(map[common.Address]*types.StateAccount)
	t.deletedAccounts = make(map[common.Address]bool)

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
