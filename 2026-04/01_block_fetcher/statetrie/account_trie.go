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
	intTrie "block_fetcher/trie"
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

// Hash computes the MPT root hash using incremental trie hashing.
// It writes dirty state to BOTH plain and hashed tables, builds a PrefixSet
// of changed keys, then runs TrieWalker + NodeIter + HashBuilder to compute
// the root. Branch node updates are persisted to the AccountTrie table.
func (t *AccountTrie) Hash() common.Hash {
	// No changes — return cached root.
	if len(t.dirtyAccounts) == 0 && len(t.deletedAccounts) == 0 {
		return t.root
	}

	// SkipHash mode: write flat state + changesets but skip trie computation.
	if t.stateDB != nil && t.stateDB.SkipHash {
		if err := t.flushStateOnly(); err != nil {
			return common.Hash{}
		}
		return common.Hash{} // dummy root — caller must not verify
	}

	root, err := t.incrementalHash()
	if err != nil {
		return common.Hash{}
	}
	t.root = root
	return t.root
}

// flushStateOnly writes dirty state and captures changesets, but skips the
// trie hash computation. Used in batch mode.
// When an overlay is active, all reads/writes go through the overlay (zero MDBX
// write transactions). Otherwise falls back to direct MDBX RW transaction.
func (t *AccountTrie) flushStateOnly() error {
	overlay := t.stateDB.Overlay
	if overlay != nil {
		return t.flushStateOnlyOverlay(overlay)
	}
	return t.flushStateOnlyMDBX()
}

// flushStateOnlyOverlay writes dirty state to the BatchOverlay and captures
// raw changesets (keyIDs assigned later during Flush).
func (t *AccountTrie) flushStateOnlyOverlay(overlay *BatchOverlay) error {
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
		balance := acct.Balance.Bytes32()
		var codeHash [32]byte
		copy(codeHash[:], acct.CodeHash)
		storeAcct := &store.Account{
			Nonce: acct.Nonce, Balance: balance,
			CodeHash: codeHash, StorageRoot: [32]byte(acct.Root),
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

// flushStateOnlyMDBX writes dirty state directly to MDBX (non-overlay path).
func (t *AccountTrie) flushStateOnlyMDBX() error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	tx, err := t.db.BeginRW()
	if err != nil {
		return err
	}

	var changes []store.Change
	acctSlot := store.AccountSentinelSlot

	for address, acct := range t.dirtyAccounts {
		var addr [20]byte
		copy(addr[:], address[:])
		hashedAddr := crypto.Keccak256(address[:])
		var ha [32]byte
		copy(ha[:], hashedAddr)

		if t.stateDB != nil {
			var oldValue []byte
			oldAcct, err := store.GetAccount(tx, t.db, addr)
			if err != nil {
				tx.Abort()
				return err
			}
			if oldAcct != nil {
				oldValue = store.EncodeAccountBytes(oldAcct)
			}
			keyID, err := store.GetOrAssignKeyID(tx, t.db, addr, acctSlot)
			if err != nil {
				tx.Abort()
				return err
			}
			changes = append(changes, store.Change{KeyID: keyID, OldValue: oldValue})
		}

		balance := acct.Balance.Bytes32()
		var codeHash [32]byte
		copy(codeHash[:], acct.CodeHash)
		storeAcct := &store.Account{
			Nonce: acct.Nonce, Balance: balance,
			CodeHash: codeHash, StorageRoot: [32]byte(acct.Root),
		}
		if err := store.PutAccount(tx, t.db, addr, storeAcct); err != nil {
			tx.Abort()
			return err
		}
		if err := store.PutHashedAccount(tx, t.db, ha, store.EncodeAccountBytes(storeAcct)); err != nil {
			tx.Abort()
			return err
		}
	}

	for address := range t.deletedAccounts {
		var addr [20]byte
		copy(addr[:], address[:])
		var ha [32]byte
		copy(ha[:], crypto.Keccak256(address[:]))

		if t.stateDB != nil {
			oldAcct, err := store.GetAccount(tx, t.db, addr)
			if err != nil {
				tx.Abort()
				return err
			}
			if oldAcct != nil {
				keyID, err := store.GetOrAssignKeyID(tx, t.db, addr, acctSlot)
				if err != nil {
					tx.Abort()
					return err
				}
				changes = append(changes, store.Change{KeyID: keyID, OldValue: store.EncodeAccountBytes(oldAcct)})
			}
		}

		if err := tx.Del(t.db.AccountState, addr[:], nil); err != nil && !mdbx.IsNotFound(err) {
			tx.Abort()
			return err
		}
		if err := store.DeleteHashedAccount(tx, t.db, ha); err != nil {
			tx.Abort()
			return err
		}
	}

	if _, err := tx.Commit(); err != nil {
		return err
	}
	if t.stateDB != nil && len(changes) > 0 {
		t.stateDB.AppendChanges(changes)
	}
	return nil
}

// incrementalHash performs the full incremental hash computation.
func (t *AccountTrie) incrementalHash() (common.Hash, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	tx, err := t.db.BeginRW()
	if err != nil {
		return common.Hash{}, err
	}

	// --- Write phase: flush dirty state to plain + hashed tables, collect changesets ---
	var changes []store.Change
	acctSlot := store.AccountSentinelSlot
	psb := intTrie.NewPrefixSetBuilder()

	for address, acct := range t.dirtyAccounts {
		var addr [20]byte
		copy(addr[:], address[:])
		hashedAddr := crypto.Keccak256(address[:])
		var ha [32]byte
		copy(ha[:], hashedAddr)

		// Add to prefix set.
		psb.AddKey(intTrie.FromHex(hashedAddr))

		// Read old value for changeset.
		if t.stateDB != nil {
			var oldValue []byte
			oldAcct, err := store.GetAccount(tx, t.db, addr)
			if err != nil {
				tx.Abort()
				return common.Hash{}, err
			}
			if oldAcct != nil {
				oldValue = store.EncodeAccountBytes(oldAcct)
			}
			keyID, err := store.GetOrAssignKeyID(tx, t.db, addr, acctSlot)
			if err != nil {
				tx.Abort()
				return common.Hash{}, err
			}
			changes = append(changes, store.Change{KeyID: keyID, OldValue: oldValue})
		}

		// Write to plain AccountState.
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
			return common.Hash{}, err
		}

		// Write to hashed HashedAccountState.
		encoded := store.EncodeAccountBytes(storeAcct)
		if err := store.PutHashedAccount(tx, t.db, ha, encoded); err != nil {
			tx.Abort()
			return common.Hash{}, err
		}
	}

	for address := range t.deletedAccounts {
		var addr [20]byte
		copy(addr[:], address[:])
		hashedAddr := crypto.Keccak256(address[:])
		var ha [32]byte
		copy(ha[:], hashedAddr)

		// Add to prefix set.
		psb.AddKey(intTrie.FromHex(hashedAddr))

		// Read old value for changeset.
		if t.stateDB != nil {
			oldAcct, err := store.GetAccount(tx, t.db, addr)
			if err != nil {
				tx.Abort()
				return common.Hash{}, err
			}
			if oldAcct != nil {
				oldValue := store.EncodeAccountBytes(oldAcct)
				keyID, err := store.GetOrAssignKeyID(tx, t.db, addr, acctSlot)
				if err != nil {
					tx.Abort()
					return common.Hash{}, err
				}
				changes = append(changes, store.Change{KeyID: keyID, OldValue: oldValue})
			}
		}

		// Delete from plain AccountState.
		if err := tx.Del(t.db.AccountState, addr[:], nil); err != nil {
			if !mdbx.IsNotFound(err) {
				tx.Abort()
				return common.Hash{}, err
			}
		}

		// Delete from HashedAccountState.
		if err := store.DeleteHashedAccount(tx, t.db, ha); err != nil {
			tx.Abort()
			return common.Hash{}, err
		}
	}

	// --- Hash phase: incremental trie hashing via Walker + NodeIter ---
	prefixSet := psb.Build()

	// Open cursor on AccountTrie for TrieWalker (stored branch nodes).
	trieCursor, err := tx.OpenCursor(t.db.AccountTrie)
	if err != nil {
		tx.Abort()
		return common.Hash{}, err
	}
	defer trieCursor.Close()

	walker := intTrie.NewTrieWalker(trieCursor, prefixSet)

	// Open cursor on HashedAccountState for leaf source.
	hashedCursor, err := tx.OpenCursor(t.db.HashedAccountState)
	if err != nil {
		tx.Abort()
		return common.Hash{}, err
	}
	defer hashedCursor.Close()

	leafSource := NewAccountLeafSource(intTrie.NewMDBXLeafSource(hashedCursor, nil))
	iter := intTrie.NewNodeIter(walker, leafSource)
	hb := intTrie.NewHashBuilder().WithUpdates()

	for {
		elem, err := iter.Next()
		if err != nil {
			tx.Abort()
			return common.Hash{}, err
		}
		if elem == nil {
			break
		}
		if elem.IsBranch {
			hb.AddBranch(elem.Key, elem.Hash, elem.ChildrenInTrie)
		} else {
			hb.AddLeaf(elem.Key, elem.Value)
		}
	}

	root := hb.Root()

	// Persist branch node updates.
	for packedPath, node := range hb.Updates() {
		if node != nil {
			if err := tx.Put(t.db.AccountTrie, []byte(packedPath), node.Encode(), 0); err != nil {
				tx.Abort()
				return common.Hash{}, err
			}
		}
	}

	// Commit the RW transaction.
	if _, err := tx.Commit(); err != nil {
		return common.Hash{}, err
	}

	// Send changeset entries to the accumulator.
	if t.stateDB != nil && len(changes) > 0 {
		t.stateDB.AppendChanges(changes)
	}

	return common.Hash(root), nil
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

// collectAllAccounts reads all accounts from MDBX and merges with dirty state,
// returning them sorted by keccak256(address).
func (t *AccountTrie) collectAllAccounts() ([]accountEntry, error) {
	// Collect all accounts from MDBX via cursor scan.
	seen := make(map[common.Address]*types.StateAccount)

	tx, done, err := t.getROTx()
	if err != nil {
		return nil, err
	}
	defer done()

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
