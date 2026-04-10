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
)

// StorageTrie implements state.Trie for per-account storage tries,
// backed by flat MDBX storage.
type StorageTrie struct {
	db           *store.DB
	address      common.Address
	root         common.Hash
	dirtySlots   map[common.Hash][]byte // key = raw 32-byte slot, value = trimmed bytes
	deletedSlots map[common.Hash]bool
}

// NewStorageTrie creates a new StorageTrie for the given address.
func NewStorageTrie(db *store.DB, address common.Address, root common.Hash) *StorageTrie {
	return &StorageTrie{
		db:           db,
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

	// Read from MDBX.
	tx, err := t.db.BeginRO()
	if err != nil {
		return nil, err
	}
	defer tx.Abort()

	var addrKey [20]byte
	copy(addrKey[:], t.address[:])
	var slotKey [32]byte
	copy(slotKey[:], slot[:])

	val, err := store.GetStorage(tx, t.db, addrKey, slotKey)
	if err != nil {
		return nil, err
	}
	// val is a [32]byte; if all zeros, the slot doesn't exist.
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

// Hash computes the storage MPT root using a StackTrie.
func (t *StorageTrie) Hash() common.Hash {
	entries, err := t.collectAllStorage()
	if err != nil {
		return common.Hash{}
	}
	if len(entries) == 0 {
		return types.EmptyRootHash
	}

	st := trie.NewStackTrie(nil)
	for _, entry := range entries {
		if err := st.Update(entry.hashedKey[:], entry.encoded); err != nil {
			return common.Hash{}
		}
	}
	return st.Hash()
}

// Commit computes the hash, flushes dirty storage to MDBX, and returns the root.
func (t *StorageTrie) Commit(collectLeaf bool) (common.Hash, *trienode.NodeSet, error) {
	root := t.Hash()

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	tx, err := t.db.BeginRW()
	if err != nil {
		return common.Hash{}, nil, err
	}

	var addr [20]byte
	copy(addr[:], t.address[:])

	// Write dirty slots.
	for slot, value := range t.dirtySlots {
		var slotKey [32]byte
		copy(slotKey[:], slot[:])

		// Pad value back to 32 bytes for storage.
		var val32 [32]byte
		copy(val32[32-len(value):], value)

		if err := store.PutStorage(tx, t.db, addr, slotKey, val32); err != nil {
			tx.Abort()
			return common.Hash{}, nil, err
		}
	}

	// Delete slots.
	for slot := range t.deletedSlots {
		var slotKey [32]byte
		copy(slotKey[:], slot[:])

		var zeroVal [32]byte
		if err := store.PutStorage(tx, t.db, addr, slotKey, zeroVal); err != nil {
			tx.Abort()
			return common.Hash{}, nil, err
		}
	}

	if _, err := tx.Commit(); err != nil {
		return common.Hash{}, nil, err
	}

	// Clear dirty state.
	t.dirtySlots = make(map[common.Hash][]byte)
	t.deletedSlots = make(map[common.Hash]bool)
	t.root = root

	return root, nil, nil
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

	tx, err := t.db.BeginRO()
	if err != nil {
		return nil, err
	}
	defer tx.Abort()

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
