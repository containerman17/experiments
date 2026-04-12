package statetrie

import (
	"bytes"
	"log"

	"github.com/erigontech/mdbx-go/mdbx"

	"block_fetcher/store"
	intTrie "block_fetcher/trie"
)

// CompareLeafEncoding finds accounts where the stored storage root differs from
// what ComputeFullStateRoot would compute. Logs differences for debugging.
func CompareLeafEncoding(tx *mdbx.Txn, db *store.DB, overlay *BatchOverlay) {
	// Recompute all storage roots from HashedStorageState.
	storageCursor, err := tx.OpenCursor(db.HashedStorageState)
	if err != nil {
		return
	}
	defer storageCursor.Close()

	storageRoots := make(map[[32]byte][32]byte)
	var curAddr [32]byte
	var hb *intTrie.HashBuilder
	first := true
	k, v, e := storageCursor.Get(nil, nil, mdbx.First)
	for e == nil && len(k) >= 64 {
		var ah [32]byte
		copy(ah[:], k[:32])
		if !first && ah != curAddr {
			if hb != nil {
				storageRoots[curAddr] = hb.Root()
			}
			hb = nil
		}
		if hb == nil {
			hb = intTrie.NewHashBuilder()
		}
		first = false
		curAddr = ah
		sh := make([]byte, 32)
		copy(sh, k[32:64])
		valCopy := make([]byte, len(v))
		copy(valCopy, v)
		hb.AddLeaf(intTrie.FromHex(sh), rlpEncodeBytesForDebug(valCopy))
		k, v, e = storageCursor.Get(nil, nil, mdbx.Next)
	}
	if hb != nil {
		storageRoots[curAddr] = hb.Root()
	}

	// Scan HashedAccountState and compare storage roots.
	acctCursor, err := tx.OpenCursor(db.HashedAccountState)
	if err != nil {
		return
	}
	defer acctCursor.Close()

	diffs := 0
	k, v, e = acctCursor.Get(nil, nil, mdbx.First)
	for e == nil && len(k) >= 32 {
		if len(v) >= 104 {
			var ha [32]byte
			copy(ha[:], k[:32])
			storedSR := v[72:104]
			// What should it be?
			expectedSR := store.EmptyRootHash
			if sr, ok := storageRoots[ha]; ok {
				expectedSR = sr
			}
			if !bytes.Equal(storedSR, expectedSR[:]) {
				diffs++
				if diffs <= 10 {
					currentSR := computeFullStorageRoot(tx, db, ha)
					step1Count := 0
					var step1Root [32]byte
					if overlay != nil && overlay.DebugStep1Counts != nil {
						step1Count = overlay.DebugStep1Counts[ha]
						step1Root = overlay.DebugStep1Roots[ha]
					}
					log.Printf("  DIFF acct %x: step1root=%x step1leaves=%d nowRoot=%x scanAllRoot=%x",
						ha[:8], step1Root[:8], step1Count, currentSR[:8], expectedSR[:8])
				}
			}
		}
		k, v, e = acctCursor.Get(nil, nil, mdbx.Next)
	}
	log.Printf("  CompareLeafEncoding: %d accounts with wrong storage roots", diffs)
}

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
		// If old storage root was emptyRoot, delete stale StorageTrie nodes.
		if oldRoot, ok := oldStorageRoots[addrHash]; ok && oldRoot == emptyRoot {
			if err := deletePrefixedEntries(tx, db.StorageTrie, addrHash[:]); err != nil {
				return [32]byte{}, err
			}
		}

		// Build PrefixSet from changed slot hashes.
		psb := intTrie.NewPrefixSetBuilder()
		for _, sh := range slotHashes {
			psb.AddKey(intTrie.FromHex(sh[:]))
		}
		prefixSet := psb.Build()

		root, updates, err := computeTrieRoot(tx, db.StorageTrie, db.HashedStorageState, addrHash[:], prefixSet, true)
		if err != nil {
			return [32]byte{}, err
		}

		// Persist branch node updates.
		for packedPath, node := range updates {
			if node == nil {
				continue
			}
			fullKey := make([]byte, len(addrHash)+len(packedPath))
			copy(fullKey, addrHash[:])
			copy(fullKey[len(addrHash):], packedPath)
			encoded := node.Encode()
			existing, err := tx.Get(db.StorageTrie, fullKey)
			if err == nil && bytes.Equal(existing, encoded) {
				continue
			}
			if err := tx.Put(db.StorageTrie, fullKey, encoded, 0); err != nil {
				return [32]byte{}, err
			}
		}

		storageRoots[addrHash] = root
	}

	// Step 2: Fix HashedAccountState entries with correct storage roots.
	patchSet := make(map[[32]byte]bool, len(changedAccounts)+len(storageRoots))
	for _, ha := range changedAccounts {
		patchSet[ha] = true
	}
	for ha := range storageRoots {
		patchSet[ha] = true
	}
	for addrHash := range patchSet {
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

	// Persist account trie branch node updates. Skip unchanged.
	written := 0
	for packedPath, node := range updates {
		if node == nil {
			continue
		}
		encoded := node.Encode()
		existing, err := tx.Get(db.AccountTrie, []byte(packedPath))
		if err == nil && bytes.Equal(existing, encoded) {
			continue // unchanged
		}
		if err := tx.Put(db.AccountTrie, []byte(packedPath), encoded, 0); err != nil {
			return [32]byte{}, err
		}
		written++
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

	updates := hb.Updates()

	// Clean up stale branch nodes: scan stored nodes and delete any that
	// the walker would have visited (under a changed prefix) but aren't in
	// the update set. Without this, old branch nodes accumulate when the trie
	// restructures, and the walker trusts their stale cached hashes.
	if _, err := deleteStaleNodes(tx, trieDBI, prefix, prefixSet, updates); err != nil {
		return [32]byte{}, nil, err
	}

	return hb.Root(), updates, nil
}

// deleteStaleNodes scans stored branch nodes and deletes any that fall under
// a changed prefix (walker would have visited) but aren't in the update set.
func deleteStaleNodes(
	tx *mdbx.Txn,
	trieDBI mdbx.DBI,
	prefix []byte,
	prefixSet *intTrie.PrefixSet,
	updates map[string]*intTrie.BranchNodeCompact,
) (int, error) {
	cursor, err := tx.OpenCursor(trieDBI)
	if err != nil {
		return 0, err
	}
	defer cursor.Close()

	var k []byte
	if prefix != nil {
		k, _, err = cursor.Get(prefix, nil, mdbx.SetRange)
	} else {
		k, _, err = cursor.Get(nil, nil, mdbx.First)
	}

	deleted := 0
	for err == nil {
		// Check prefix scope.
		if prefix != nil && (len(k) < len(prefix) || !bytes.HasPrefix(k, prefix)) {
			break
		}

		// Extract the packed path (strip prefix if present).
		var packedPath []byte
		if prefix != nil {
			packedPath = k[len(prefix):]
		} else {
			packedPath = k
		}

		// Unpack to nibbles and check if this path is under a changed prefix.
		nibblePath := intTrie.Unpack(packedPath)
		if prefixSet.ContainsPrefix(nibblePath) {
			// Walker would have visited this node. Is it in updates?
			pathKey := string(packedPath)
			if _, ok := updates[pathKey]; !ok {
				// Stale node — delete it.
				if err := cursor.Del(0); err != nil {
					return deleted, err
				}
				deleted++
				// After Del, cursor advances to next — don't call Next.
				k, _, err = cursor.Get(nil, nil, mdbx.GetCurrent)
				if err != nil {
					break
				}
				continue
			}
		}

		k, _, err = cursor.Get(nil, nil, mdbx.Next)
	}

	return deleted, nil
}

// ComputeFullStateRoot computes the state root from scratch by scanning ALL
// hashed state. No stored branch nodes, no PrefixSet. O(total_state) but
// guaranteed correct. Used for debugging only — does NOT write anything.
func ComputeFullStateRoot(tx *mdbx.Txn, db *store.DB) ([32]byte, error) {
	// Step 1: Collect all storage, compute storage roots per account.
	storageCursor, err := tx.OpenCursor(db.HashedStorageState)
	if err != nil {
		return [32]byte{}, err
	}
	defer storageCursor.Close()

	storageRoots := make(map[[32]byte][32]byte)
	var currentAddr [32]byte
	var hb *intTrie.HashBuilder
	k, v, e := storageCursor.Get(nil, nil, mdbx.First)
	for e == nil && len(k) >= 64 {
		var addrHash [32]byte
		copy(addrHash[:], k[:32])

		if addrHash != currentAddr {
			if hb != nil {
				storageRoots[currentAddr] = hb.Root()
			}
			currentAddr = addrHash
			hb = intTrie.NewHashBuilder()
		}

		slotHash := make([]byte, 32)
		copy(slotHash, k[32:64])
		valCopy := make([]byte, len(v))
		copy(valCopy, v)
		hb.AddLeaf(intTrie.FromHex(slotHash), rlpEncodeBytesForDebug(valCopy))

		k, v, e = storageCursor.Get(nil, nil, mdbx.Next)
	}
	if hb != nil {
		storageRoots[currentAddr] = hb.Root()
	}

	// Step 2: Scan all accounts, patch storage roots, compute account root.
	acctCursor, err := tx.OpenCursor(db.HashedAccountState)
	if err != nil {
		return [32]byte{}, err
	}
	defer acctCursor.Close()

	acctHB := intTrie.NewHashBuilder()
	k, v, e = acctCursor.Get(nil, nil, mdbx.First)
	for e == nil && len(k) >= 32 {
		var ha [32]byte
		copy(ha[:], k[:32])

		valCopy := make([]byte, len(v))
		copy(valCopy, v)

		// Patch storage root if we computed one.
		if len(valCopy) >= 104 {
			if sr, ok := storageRoots[ha]; ok {
				copy(valCopy[72:104], sr[:])
			}
		}

		leafSource := NewAccountLeafSource(&singleLeafSource{key: k[:32], val: valCopy})
		lk, lv, _ := leafSource.Next()
		if lk != nil {
			acctHB.AddLeaf(intTrie.FromHex(lk), lv)
		}

		k, v, e = acctCursor.Get(nil, nil, mdbx.Next)
	}

	return acctHB.Root(), nil
}

// singleLeafSource returns one leaf then exhausts.
type singleLeafSource struct {
	key  []byte
	val  []byte
	done bool
}

func (s *singleLeafSource) Next() ([]byte, []byte, error) {
	if s.done {
		return nil, nil, nil
	}
	s.done = true
	return s.key, s.val, nil
}

// computeFullStorageRoot scans ALL storage for an account and hashes from scratch.
func computeFullStorageRoot(tx *mdbx.Txn, db *store.DB, addrHash [32]byte) [32]byte {
	cursor, err := tx.OpenCursor(db.HashedStorageState)
	if err != nil {
		return emptyRoot
	}
	defer cursor.Close()

	hb := intTrie.NewHashBuilder()
	k, v, e := cursor.Get(addrHash[:], nil, mdbx.SetRange)
	for e == nil && len(k) >= 64 {
		var ah [32]byte
		copy(ah[:], k[:32])
		if ah != addrHash {
			break
		}
		sh := make([]byte, 32)
		copy(sh, k[32:64])
		valCopy := make([]byte, len(v))
		copy(valCopy, v)
		hb.AddLeaf(intTrie.FromHex(sh), rlpEncodeBytesForDebug(valCopy))
		k, v, e = cursor.Get(nil, nil, mdbx.Next)
	}
	return hb.Root()
}

func rlpEncodeBytesForDebug(val []byte) []byte {
	if len(val) == 1 && val[0] <= 0x7f {
		return []byte{val[0]}
	}
	if len(val) <= 55 {
		out := make([]byte, 1+len(val))
		out[0] = 0x80 + byte(len(val))
		copy(out[1:], val)
		return out
	}
	return val // shouldn't happen for storage values
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
		// After Del, cursor points to successor — use GetCurrent, not Next.
		k, _, err = cursor.Get(nil, nil, mdbx.GetCurrent)
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
