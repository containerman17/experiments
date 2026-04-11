package statetrie

import (
	"bytes"
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

	"block_fetcher/store"
	intTrie "block_fetcher/trie"
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

// Hash computes the storage MPT root using incremental trie hashing.
// It writes dirty state to BOTH plain and hashed tables, builds a PrefixSet
// of changed keys, then runs TrieWalker + NodeIter + HashBuilder.
func (t *StorageTrie) Hash() common.Hash {
	// No changes — return cached root.
	if len(t.dirtySlots) == 0 && len(t.deletedSlots) == 0 {
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

// flushStateOnly writes dirty storage and captures changesets, but skips the
// trie hash computation. Used in batch mode.
// When an overlay is active, all reads/writes go through the overlay (zero MDBX
// write transactions). Otherwise falls back to direct MDBX RW transaction.
func (t *StorageTrie) flushStateOnly() error {
	overlay := t.stateDB.Overlay
	if overlay != nil {
		return t.flushStateOnlyOverlay(overlay)
	}
	return t.flushStateOnlyMDBX()
}

// flushStateOnlyOverlay writes dirty storage to the BatchOverlay and captures
// raw changesets (keyIDs assigned later during Flush).
func (t *StorageTrie) flushStateOnlyOverlay(overlay *BatchOverlay) error {
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

// flushStateOnlyMDBX writes dirty storage directly to MDBX (non-overlay path).
func (t *StorageTrie) flushStateOnlyMDBX() error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	tx, err := t.db.BeginRW()
	if err != nil {
		return err
	}

	var addr [20]byte
	copy(addr[:], t.address[:])
	addrHash := crypto.Keccak256(t.address[:])
	var addrHash32 [32]byte
	copy(addrHash32[:], addrHash)

	var changes []store.Change

	for slot, value := range t.dirtySlots {
		var slotKey [32]byte
		copy(slotKey[:], slot[:])
		var hs [32]byte
		copy(hs[:], crypto.Keccak256(slot[:]))

		if t.stateDB != nil {
			oldVal, err := store.GetStorage(tx, t.db, addr, slotKey)
			if err != nil {
				tx.Abort()
				return err
			}
			var oldValue []byte
			if oldVal != [32]byte{} {
				trimmed := trimLeadingZeros(oldVal[:])
				oldValue = make([]byte, len(trimmed))
				copy(oldValue, trimmed)
			}
			keyID, err := store.GetOrAssignKeyID(tx, t.db, addr, slotKey)
			if err != nil {
				tx.Abort()
				return err
			}
			changes = append(changes, store.Change{KeyID: keyID, OldValue: oldValue})
		}

		var val32 [32]byte
		copy(val32[32-len(value):], value)
		if err := store.PutStorage(tx, t.db, addr, slotKey, val32); err != nil {
			tx.Abort()
			return err
		}
		if err := store.PutHashedStorage(tx, t.db, addrHash32, hs, value); err != nil {
			tx.Abort()
			return err
		}
	}

	for slot := range t.deletedSlots {
		var slotKey [32]byte
		copy(slotKey[:], slot[:])
		var hs [32]byte
		copy(hs[:], crypto.Keccak256(slot[:]))

		if t.stateDB != nil {
			oldVal, err := store.GetStorage(tx, t.db, addr, slotKey)
			if err != nil {
				tx.Abort()
				return err
			}
			if oldVal != [32]byte{} {
				trimmed := trimLeadingZeros(oldVal[:])
				oldValue := make([]byte, len(trimmed))
				copy(oldValue, trimmed)
				keyID, err := store.GetOrAssignKeyID(tx, t.db, addr, slotKey)
				if err != nil {
					tx.Abort()
					return err
				}
				changes = append(changes, store.Change{KeyID: keyID, OldValue: oldValue})
			}
		}

		var zeroVal [32]byte
		if err := store.PutStorage(tx, t.db, addr, slotKey, zeroVal); err != nil {
			tx.Abort()
			return err
		}
		if err := store.DeleteHashedStorage(tx, t.db, addrHash32, hs); err != nil {
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

// incrementalHash performs the full incremental hash computation for storage.
func (t *StorageTrie) incrementalHash() (common.Hash, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	tx, err := t.db.BeginRW()
	if err != nil {
		return common.Hash{}, err
	}

	var addr [20]byte
	copy(addr[:], t.address[:])
	addrHash := crypto.Keccak256(t.address[:])
	var addrHash32 [32]byte
	copy(addrHash32[:], addrHash)

	// --- Build PrefixSet from changed keys ---
	psb := intTrie.NewPrefixSetBuilder()

	// --- Write phase: flush dirty state to plain + hashed tables, collect changesets ---
	var changes []store.Change

	for slot, value := range t.dirtySlots {
		var slotKey [32]byte
		copy(slotKey[:], slot[:])
		hashedSlot := crypto.Keccak256(slot[:])
		var hs [32]byte
		copy(hs[:], hashedSlot)

		// Add to prefix set.
		psb.AddKey(intTrie.FromHex(hashedSlot))

		// Read old value for changeset.
		if t.stateDB != nil {
			oldVal, err := store.GetStorage(tx, t.db, addr, slotKey)
			if err != nil {
				tx.Abort()
				return common.Hash{}, err
			}
			var oldValue []byte
			if oldVal != [32]byte{} {
				trimmed := trimLeadingZeros(oldVal[:])
				oldValue = make([]byte, len(trimmed))
				copy(oldValue, trimmed)
			}
			keyID, err := store.GetOrAssignKeyID(tx, t.db, addr, slotKey)
			if err != nil {
				tx.Abort()
				return common.Hash{}, err
			}
			changes = append(changes, store.Change{KeyID: keyID, OldValue: oldValue})
		}

		// Write to plain StorageState.
		var val32 [32]byte
		copy(val32[32-len(value):], value)
		if err := store.PutStorage(tx, t.db, addr, slotKey, val32); err != nil {
			tx.Abort()
			return common.Hash{}, err
		}

		// Write to HashedStorageState (trimmed value).
		if err := store.PutHashedStorage(tx, t.db, addrHash32, hs, value); err != nil {
			tx.Abort()
			return common.Hash{}, err
		}
	}

	for slot := range t.deletedSlots {
		var slotKey [32]byte
		copy(slotKey[:], slot[:])
		hashedSlot := crypto.Keccak256(slot[:])
		var hs [32]byte
		copy(hs[:], hashedSlot)

		// Add to prefix set.
		psb.AddKey(intTrie.FromHex(hashedSlot))

		// Read old value for changeset.
		if t.stateDB != nil {
			oldVal, err := store.GetStorage(tx, t.db, addr, slotKey)
			if err != nil {
				tx.Abort()
				return common.Hash{}, err
			}
			if oldVal != [32]byte{} {
				trimmed := trimLeadingZeros(oldVal[:])
				oldValue := make([]byte, len(trimmed))
				copy(oldValue, trimmed)
				keyID, err := store.GetOrAssignKeyID(tx, t.db, addr, slotKey)
				if err != nil {
					tx.Abort()
					return common.Hash{}, err
				}
				changes = append(changes, store.Change{KeyID: keyID, OldValue: oldValue})
			}
		}

		// Delete from plain StorageState (write zero).
		var zeroVal [32]byte
		if err := store.PutStorage(tx, t.db, addr, slotKey, zeroVal); err != nil {
			tx.Abort()
			return common.Hash{}, err
		}

		// Delete from HashedStorageState.
		if err := store.DeleteHashedStorage(tx, t.db, addrHash32, hs); err != nil {
			tx.Abort()
			return common.Hash{}, err
		}
	}

	// --- Hash phase: incremental trie hashing via Walker + NodeIter ---
	prefixSet := psb.Build()

	// Open cursor on StorageTrie with address prefix for TrieWalker.
	rawTrieCursor, err := tx.OpenCursor(t.db.StorageTrie)
	if err != nil {
		tx.Abort()
		return common.Hash{}, err
	}
	defer rawTrieCursor.Close()

	trieCursor := NewPrefixedTrieCursor(rawTrieCursor, addrHash)
	walker := intTrie.NewTrieWalker(trieCursor, prefixSet)

	// Open cursor on HashedStorageState with address prefix for leaf source.
	hashedCursor, err := tx.OpenCursor(t.db.HashedStorageState)
	if err != nil {
		tx.Abort()
		return common.Hash{}, err
	}
	defer hashedCursor.Close()

	leafSource := NewStorageLeafSource(intTrie.NewMDBXLeafSource(hashedCursor, addrHash))
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

	// Persist branch node updates (prefixed by addrHash for per-account scoping).
	for packedPath, node := range hb.Updates() {
		if node != nil {
			fullKey := make([]byte, len(addrHash)+len(packedPath))
			copy(fullKey, addrHash)
			copy(fullKey[len(addrHash):], packedPath)
			if err := tx.Put(t.db.StorageTrie, fullKey, node.Encode(), 0); err != nil {
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

	rootHash := common.Hash(root)
	// If empty root (keccak(rlp(""))), use types.EmptyRootHash for consistency.
	if rootHash == intTrie.EmptyRootHash {
		rootHash = types.EmptyRootHash
	}

	return rootHash, nil
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

// collectAllStorage reads all storage for this address from MDBX and merges
// with dirty state, returning entries sorted by keccak256(slot).
func (t *StorageTrie) collectAllStorage() ([]storageEntry, error) {
	seen := make(map[common.Hash][]byte) // slot -> trimmed value

	tx, done, err := t.getROTx()
	if err != nil {
		return nil, err
	}
	defer done()

	cursor, err := tx.OpenCursor(t.db.StorageState)
	if err != nil {
		return nil, err
	}
	defer cursor.Close()

	// Storage keys are 52 bytes: 20 (address) + 32 (slot).
	// We need to scan for keys with matching address prefix.
	var addrPrefix [20]byte
	copy(addrPrefix[:], t.address[:])

	key, val, err := cursor.Get(addrPrefix[:], nil, mdbx.SetRange)
	for err == nil {
		if len(key) != 52 || !bytes.Equal(key[:20], addrPrefix[:]) {
			break
		}

		var slot common.Hash
		copy(slot[:], key[20:52])

		if !t.deletedSlots[slot] {
			// Value is stored trimmed (leading zeros stripped). Copy it.
			trimmed := make([]byte, len(val))
			copy(trimmed, val)
			seen[slot] = trimmed
		}

		key, val, err = cursor.Get(nil, nil, mdbx.Next)
	}
	if err != nil && !mdbx.IsNotFound(err) {
		return nil, err
	}

	// Override with dirty slots.
	for slot, val := range t.dirtySlots {
		seen[slot] = val
	}

	// Remove deleted slots.
	for slot := range t.deletedSlots {
		delete(seen, slot)
	}

	// Build sorted entries by keccak256(slot).
	entries := make([]storageEntry, 0, len(seen))
	for slot, val := range seen {
		hashedKey := crypto.Keccak256Hash(slot[:])

		// RLP-encode the trimmed value, matching StateTrie.UpdateStorage behavior.
		encoded, err := rlp.EncodeToBytes(val)
		if err != nil {
			return nil, err
		}

		var hk [32]byte
		copy(hk[:], hashedKey[:])
		entries = append(entries, storageEntry{hashedKey: hk, encoded: encoded})
	}

	sort.Slice(entries, func(i, j int) bool {
		return compareBytes32(entries[i].hashedKey, entries[j].hashedKey) < 0
	})

	return entries, nil
}
