package statetrie

import (
	"bytes"
	"errors"

	"github.com/ava-labs/libevm/common"
	"github.com/ava-labs/libevm/core/types"
	"github.com/ava-labs/libevm/ethdb"
	"github.com/ava-labs/libevm/trie"
	"github.com/ava-labs/libevm/trie/trienode"
	"github.com/erigontech/mdbx-go/mdbx"

	"block_fetcher/store"
)

// StorageTrie implements state.Trie for per-account storage tries,
// backed by flat MDBX storage.
type StorageTrie struct {
	db           *store.DB
	stateDB      *Database // parent Database for changeset accumulation
	address      common.Address
	root         common.Hash
	dirtySlots   map[common.Hash][]byte // key = raw 32-byte slot, value = trimmed bytes
	deletedSlots map[common.Hash]bool
}

// NewStorageTrie creates a new StorageTrie for the given address.
func NewStorageTrie(db *store.DB, stateDB *Database, address common.Address, root common.Hash) *StorageTrie {
	return &StorageTrie{
		db:           db,
		stateDB:      stateDB,
		address:      address,
		root:         root,
		dirtySlots:   make(map[common.Hash][]byte),
		deletedSlots: make(map[common.Hash]bool),
	}
}

// Copy returns a deep copy of the StorageTrie.
func (t *StorageTrie) Copy() *StorageTrie {
	cp := &StorageTrie{
		db:           t.db,
		stateDB:      t.stateDB,
		address:      t.address,
		root:         t.root,
		dirtySlots:   make(map[common.Hash][]byte, len(t.dirtySlots)),
		deletedSlots: make(map[common.Hash]bool, len(t.deletedSlots)),
	}
	for slot, val := range t.dirtySlots {
		v := make([]byte, len(val))
		copy(v, val)
		cp.dirtySlots[slot] = v
	}
	for slot := range t.deletedSlots {
		cp.deletedSlots[slot] = true
	}
	return cp
}

// getROTx returns a shared batch RO tx if available, otherwise opens a fresh one.
func (t *StorageTrie) getROTx() (*mdbx.Txn, func(), error) {
	if t.stateDB != nil {
		return t.stateDB.GetROTx()
	}
	tx, err := t.db.BeginRO()
	if err != nil {
		return nil, nil, err
	}
	return tx, func() { tx.Abort() }, nil
}

// GetKey returns nil (preimage lookup not needed).
func (t *StorageTrie) GetKey([]byte) []byte {
	return nil
}

// GetAccount is not applicable for a storage trie.
func (t *StorageTrie) GetAccount(address common.Address) (*types.StateAccount, error) {
	return nil, errors.New("GetAccount not supported on StorageTrie")
}

// UpdateAccount is not applicable for a storage trie.
func (t *StorageTrie) UpdateAccount(address common.Address, account *types.StateAccount) error {
	return errors.New("UpdateAccount not supported on StorageTrie")
}

// DeleteAccount is not applicable for a storage trie.
func (t *StorageTrie) DeleteAccount(address common.Address) error {
	return errors.New("DeleteAccount not supported on StorageTrie")
}

// GetStorage retrieves a storage value for the given slot.
// Returns the RLP-decoded content (matching StateTrie.GetStorage behavior:
// the trie stores rlp.EncodeToBytes(trimmedValue), and GetStorage returns
// the decoded content via rlp.Split).
func (t *StorageTrie) GetStorage(addr common.Address, key []byte) ([]byte, error) {
	var slot common.Hash
	copy(slot[:], key)

	// Check deleted.
	if t.deletedSlots[slot] {
		return nil, nil
	}

	// Check dirty map. Dirty values are stored as trimmed bytes (what
	// UpdateStorage receives). GetStorage should return these same trimmed bytes
	// because the caller (StateDB) expects the same format that was passed to
	// UpdateStorage.
	if val, ok := t.dirtySlots[slot]; ok {
		return val, nil
	}

	// Read from overlay→MDBX (current or historical).
	tx, done, err := t.getROTx()
	if err != nil {
		return nil, err
	}
	defer done()

	var addrKey [20]byte
	copy(addrKey[:], t.address[:])
	var slotKey [32]byte
	copy(slotKey[:], slot[:])

	var val [32]byte
	if t.stateDB != nil && t.stateDB.historicalBlock > 0 {
		val, err = store.LookupHistoricalStorage(tx, t.db, addrKey, slotKey, t.stateDB.historicalBlock)
	} else if t.stateDB != nil && t.stateDB.Overlay != nil {
		val, err = t.stateDB.Overlay.GetStorage(tx, t.db, addrKey, slotKey)
	} else {
		val, err = store.GetStorage(tx, t.db, addrKey, slotKey)
	}
	if err != nil {
		return nil, err
	}
	if val == [32]byte{} {
		return nil, nil
	}

	// Trim leading zeros to match what StateTrie.GetStorage returns.
	trimmed := bytes.TrimLeft(val[:], "\x00")
	if len(trimmed) == 0 {
		return nil, nil
	}
	return trimmed, nil
}

// UpdateStorage stores a value in the dirty map.
// Value is the raw trimmed bytes (StateTrie.UpdateStorage receives trimmed bytes,
// then RLP-encodes internally before inserting into the trie).
func (t *StorageTrie) UpdateStorage(addr common.Address, key, value []byte) error {
	var slot common.Hash
	copy(slot[:], key)

	delete(t.deletedSlots, slot)

	if len(value) == 0 {
		// Treat empty value as deletion.
		t.deletedSlots[slot] = true
		delete(t.dirtySlots, slot)
		return nil
	}

	v := make([]byte, len(value))
	copy(v, value)
	t.dirtySlots[slot] = v
	return nil
}

// DeleteStorage marks a storage slot as deleted.
func (t *StorageTrie) DeleteStorage(addr common.Address, key []byte) error {
	var slot common.Hash
	copy(slot[:], key)

	delete(t.dirtySlots, slot)
	t.deletedSlots[slot] = true
	return nil
}

// UpdateContractCode is not applicable for a storage trie.
func (t *StorageTrie) UpdateContractCode(address common.Address, codeHash common.Hash, code []byte) error {
	return errors.New("UpdateContractCode not supported on StorageTrie")
}

// storageEntry is a helper for sorting storage by hashed key.
type storageEntry struct {
	hashedKey [32]byte
	encoded   []byte
}

// Hash flushes dirty storage state to the overlay (or MDBX in non-overlay mode).
// It does NOT compute the trie hash — that's done once per batch by
// ComputeIncrementalStateRoot. Returns a dummy hash.
func (t *StorageTrie) Hash() common.Hash {
	if len(t.dirtySlots) == 0 && len(t.deletedSlots) == 0 {
		return t.root
	}

	if err := t.flushStateOnly(); err != nil {
		return common.Hash{}
	}
	return common.Hash{} // dummy — real root computed at batch boundary
}

// flushStateOnly writes dirty storage state to the overlay and captures
// raw changesets (keyIDs assigned later during Flush).
func (t *StorageTrie) flushStateOnly() error {
	overlay := t.stateDB.Overlay
	// We need a RO transaction to read old values for changeset capture.
	tx, err := t.db.BeginRO()
	if err != nil {
		return err
	}
	defer tx.Abort()

	var addr [20]byte
	copy(addr[:], t.address[:])

	var rawChanges []RawChange

	for slot, value := range t.dirtySlots {
		var slotKey [32]byte
		copy(slotKey[:], slot[:])

		// Read old value from overlay→MDBX BEFORE writing new value.
		if t.stateDB != nil {
			oldVal, err := overlay.GetStorage(tx, t.db, addr, slotKey)
			if err != nil {
				return err
			}
			var oldValue []byte
			if oldVal != [32]byte{} {
				trimmed := trimLeadingZeros(oldVal[:])
				oldValue = make([]byte, len(trimmed))
				copy(oldValue, trimmed)
			}
			rawChanges = append(rawChanges, RawChange{Addr: addr, Slot: slotKey, OldValue: oldValue})
		}

		// Write new value to overlay.
		var val32 [32]byte
		copy(val32[32-len(value):], value)
		overlay.PutStorage(addr, slotKey, val32, value)
	}

	for slot := range t.deletedSlots {
		var slotKey [32]byte
		copy(slotKey[:], slot[:])

		// Read old value from overlay→MDBX BEFORE deleting.
		if t.stateDB != nil {
			oldVal, err := overlay.GetStorage(tx, t.db, addr, slotKey)
			if err != nil {
				return err
			}
			if oldVal != [32]byte{} {
				trimmed := trimLeadingZeros(oldVal[:])
				oldValue := make([]byte, len(trimmed))
				copy(oldValue, trimmed)
				rawChanges = append(rawChanges, RawChange{Addr: addr, Slot: slotKey, OldValue: oldValue})
			}
		}

		overlay.DeleteStorage(addr, slotKey)
	}

	if t.stateDB != nil && len(rawChanges) > 0 {
		t.stateDB.AppendRawChanges(rawChanges)
	}
	return nil
}


// Commit returns the cached root from Hash() and clears dirty state.
// All actual work (writing state, changeset collection, branch node updates)
// is done in Hash().
func (t *StorageTrie) Commit(collectLeaf bool) (common.Hash, *trienode.NodeSet, error) {
	// Ensure Hash() has been called (state.StateDB always calls Hash() before Commit()).
	root := t.Hash()

	// Clear dirty state.
	t.dirtySlots = make(map[common.Hash][]byte)
	t.deletedSlots = make(map[common.Hash]bool)

	return root, nil, nil
}

// trimLeadingZeros removes leading zero bytes, keeping at least one byte.
func trimLeadingZeros(b []byte) []byte {
	for len(b) > 1 && b[0] == 0 {
		b = b[1:]
	}
	return b
}

// NodeIterator is not supported.
func (t *StorageTrie) NodeIterator(startKey []byte) (trie.NodeIterator, error) {
	return nil, errors.New("NodeIterator not supported")
}

// Prove is not supported.
func (t *StorageTrie) Prove(key []byte, proofDb ethdb.KeyValueWriter) error {
	return errors.New("Prove not supported")
}
