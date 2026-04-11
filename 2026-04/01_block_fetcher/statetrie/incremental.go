package statetrie

import (
	"bytes"

	"github.com/erigontech/mdbx-go/mdbx"

	"block_fetcher/store"
	intTrie "block_fetcher/trie"
)

// emptyRoot is keccak256(RLP("")) = keccak256(0x80).
var emptyRoot = [32]byte{
	0x56, 0xe8, 0x1f, 0x17, 0x1b, 0xcc, 0x55, 0xa6,
	0xff, 0x83, 0x45, 0xe6, 0x92, 0xc0, 0xf8, 0x6e,
	0x5b, 0x48, 0xe0, 0x1b, 0x99, 0x6c, 0xad, 0xc0,
	0x01, 0x62, 0x2f, 0xb5, 0xe3, 0x63, 0xb4, 0x21,
}

// ComputeIncrementalStateRoot computes the state root by incrementally hashing
// only the portions of the trie that changed during the batch. It:
//  1. Computes storage roots for accounts with changed storage
//  2. Fixes HashedAccountState entries with correct storage roots
//  3. Computes account trie root
//
// The tx must be a RW transaction with overlay state already flushed.
// oldStorageRoots contains the pre-batch storage roots for changed accounts
// (needed because Hash() during execution writes dummy zeros for storage roots).
func ComputeIncrementalStateRoot(
	tx *mdbx.Txn,
	db *store.DB,
	overlay *BatchOverlay,
	oldStorageRoots map[[32]byte][32]byte,
) ([32]byte, error) {
	changedStorage := overlay.ChangedStorageGrouped()
	changedAccounts := overlay.ChangedAccountHashes()

	// Step 1: Compute storage roots for accounts with changed storage.
	storageRoots := make(map[[32]byte][32]byte)

	for addrHash, slotHashes := range changedStorage {
		// Build PrefixSet from changed slot hashes.
		psb := intTrie.NewPrefixSetBuilder()
		for _, sh := range slotHashes {
			psb.AddKey(intTrie.FromHex(sh[:]))
		}
		prefixSet := psb.Build()

		// Clear stale StorageTrie branch nodes for this account before recomputing.
		if err := deletePrefixedEntries(tx, db.StorageTrie, addrHash[:]); err != nil {
			return [32]byte{}, err
		}

		root, updates, err := computeTrieRoot(tx, db.StorageTrie, db.HashedStorageState, addrHash[:], prefixSet, true)
		if err != nil {
			return [32]byte{}, err
		}

		// Persist branch node updates (prefixed with addrHash).
		for packedPath, node := range updates {
			fullKey := make([]byte, len(addrHash)+len(packedPath))
			copy(fullKey, addrHash[:])
			copy(fullKey[len(addrHash):], packedPath)
			if node != nil {
				if err := tx.Put(db.StorageTrie, fullKey, node.Encode(), 0); err != nil {
					return [32]byte{}, err
				}
			}
		}

		storageRoots[addrHash] = root
	}

	// Step 2: Fix HashedAccountState entries with correct storage roots.
	for _, addrHash := range changedAccounts {
		var correctRoot [32]byte

		if newRoot, ok := storageRoots[addrHash]; ok {
			// Storage changed — use freshly computed root.
			correctRoot = newRoot
		} else if oldRoot, ok := oldStorageRoots[addrHash]; ok {
			// No storage change but account changed — restore pre-batch root.
			correctRoot = oldRoot
		} else {
			// New account with no prior storage root — empty.
			correctRoot = emptyRoot
		}

		// Read current entry, patch storage root (bytes 72-104), write back.
		val, err := tx.Get(db.HashedAccountState, addrHash[:])
		if err != nil {
			if mdbx.IsNotFound(err) {
				continue // deleted account
			}
			return [32]byte{}, err
		}
		if len(val) < 104 {
			continue
		}
		updated := make([]byte, len(val))
		copy(updated, val)
		copy(updated[72:104], correctRoot[:])
		if err := tx.Put(db.HashedAccountState, addrHash[:], updated, 0); err != nil {
			return [32]byte{}, err
		}
	}

	// Step 3: Build account PrefixSet from all changed accounts.
	psb := intTrie.NewPrefixSetBuilder()
	for _, ha := range changedAccounts {
		psb.AddKey(intTrie.FromHex(ha[:]))
	}
	// Also include accounts whose storage roots changed but weren't in changedAccounts.
	for addrHash := range storageRoots {
		psb.AddKey(intTrie.FromHex(addrHash[:]))
	}
	accountPrefixSet := psb.Build()

	// Step 4: Compute account trie root.
	root, updates, err := computeTrieRoot(tx, db.AccountTrie, db.HashedAccountState, nil, accountPrefixSet, false)
	if err != nil {
		return [32]byte{}, err
	}

	// Persist account trie branch node updates.
	for packedPath, node := range updates {
		if node != nil {
			if err := tx.Put(db.AccountTrie, []byte(packedPath), node.Encode(), 0); err != nil {
				return [32]byte{}, err
			}
		}
	}

	return root, nil
}

// computeTrieRoot runs the incremental hash (Walker → NodeIter → HashBuilder)
// over a trie table + hashed state table.
// prefix scopes the cursors (nil for account trie, addrHash for storage).
// isStorage controls which LeafSource to use.
func computeTrieRoot(
	tx *mdbx.Txn,
	trieDBI mdbx.DBI,
	stateDBI mdbx.DBI,
	prefix []byte,
	prefixSet *intTrie.PrefixSet,
	isStorage bool,
) ([32]byte, map[string]*intTrie.BranchNodeCompact, error) {
	// Open trie cursor (for stored branch nodes).
	trieCursorRaw, err := tx.OpenCursor(trieDBI)
	if err != nil {
		return [32]byte{}, nil, err
	}
	defer trieCursorRaw.Close()

	var trieCursor intTrie.TrieCursor
	if prefix != nil {
		trieCursor = NewPrefixedTrieCursor(trieCursorRaw, prefix)
	} else {
		trieCursor = trieCursorRaw
	}
	walker := intTrie.NewTrieWalker(trieCursor, prefixSet)

	// Open state cursor (for leaf values).
	stateCursor, err := tx.OpenCursor(stateDBI)
	if err != nil {
		return [32]byte{}, nil, err
	}
	defer stateCursor.Close()

	var leafSource intTrie.LeafSource
	mdbxSource := intTrie.NewMDBXLeafSource(stateCursor, prefix)
	if isStorage {
		leafSource = NewStorageLeafSource(mdbxSource)
	} else {
		leafSource = NewAccountLeafSource(mdbxSource)
	}

	iter := intTrie.NewNodeIter(walker, leafSource)
	hb := intTrie.NewHashBuilder().WithUpdates()

	for {
		elem, err := iter.Next()
		if err != nil {
			return [32]byte{}, nil, err
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

	return hb.Root(), hb.Updates(), nil
}

// deletePrefixedEntries removes all entries from a DBI whose key starts with prefix.
func deletePrefixedEntries(tx *mdbx.Txn, dbi mdbx.DBI, prefix []byte) error {
	cursor, err := tx.OpenCursor(dbi)
	if err != nil {
		return err
	}
	defer cursor.Close()

	k, _, err := cursor.Get(prefix, nil, mdbx.SetRange)
	for err == nil && len(k) >= len(prefix) && bytes.HasPrefix(k, prefix) {
		if err := cursor.Del(0); err != nil {
			return err
		}
		k, _, err = cursor.Get(nil, nil, mdbx.Next)
	}
	return nil
}

// ReadOldStorageRoots reads current storage roots from HashedAccountState
// for the given account hashes. Call this BEFORE flushing the overlay.
func ReadOldStorageRoots(tx *mdbx.Txn, db *store.DB, accountHashes [][32]byte) map[[32]byte][32]byte {
	result := make(map[[32]byte][32]byte, len(accountHashes))
	for _, ha := range accountHashes {
		val, err := tx.Get(db.HashedAccountState, ha[:])
		if err != nil || len(val) < 104 {
			result[ha] = emptyRoot
			continue
		}
		var root [32]byte
		copy(root[:], val[72:104])
		result[ha] = root
	}
	return result
}

// Verify that we satisfy the TrieCursor interface from the trie package.
// mdbx.Cursor already implements it — this is just to make the compiler happy.
var _ intTrie.TrieCursor = (*mdbx.Cursor)(nil)
