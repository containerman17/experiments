package statetrie

import (
	"bytes"
	"encoding/hex"
	"log"
	"os"
	"sort"

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

type trieComputeStats struct {
	LeafElems         int
	BranchElems       int
	StaleNodesDeleted int
}

type IncrementalStats struct {
	ChangedAccounts     int
	ChangedStorageAccts int
	ChangedStorageSlots int
	StorageLeafElems    int
	StorageBranchElems  int
	StorageStaleDeleted int
	StorageTrieWrites   int
	AccountLeafElems    int
	AccountBranchElems  int
	AccountStaleDeleted int
	AccountTrieWrites   int
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
) ([32]byte, *IncrementalStats, error) {
	changedStorage := overlay.ChangedStorageGrouped()
	changedAccounts := overlay.ChangedAccountHashes()
	traceTarget, traceEnabled := parseTraceStorageAccount()
	verifyStorageIncremental := os.Getenv("VERIFY_STORAGE_INCREMENTAL") != ""
	stats := &IncrementalStats{
		ChangedAccounts:     len(changedAccounts),
		ChangedStorageAccts: len(changedStorage),
	}
	for _, slotHashes := range changedStorage {
		stats.ChangedStorageSlots += len(slotHashes)
	}

	// Step 1: Compute storage roots for accounts with changed storage.
	storageRoots := make(map[[32]byte][32]byte)

	for addrHash, slotHashes := range changedStorage {
		// If old storage root was emptyRoot, delete stale StorageTrie nodes.
		if oldRoot, ok := oldStorageRoots[addrHash]; ok && oldRoot == emptyRoot {
			if err := deletePrefixedEntries(tx, db.StorageTrie, addrHash[:]); err != nil {
				return [32]byte{}, nil, err
			}
		}

		// Build PrefixSet from changed slot hashes.
		psb := intTrie.NewPrefixSetBuilder()
		for _, sh := range slotHashes {
			psb.AddKey(intTrie.FromHex(sh[:]))
		}
		prefixSet := psb.Build()

		var trace *storageTrieTrace
		if traceEnabled && addrHash == traceTarget {
			var traceErr error
			trace, traceErr = newStorageTrieTrace(tx, db.HashedStorageState, addrHash, slotHashes)
			if traceErr != nil {
				return [32]byte{}, nil, traceErr
			}
		}

		root, updates, trieStats, err := computeTrieRoot(tx, db.StorageTrie, db.HashedStorageState, addrHash[:], prefixSet, true, trace)
		if err != nil {
			return [32]byte{}, nil, err
		}
		stats.StorageLeafElems += trieStats.LeafElems
		stats.StorageBranchElems += trieStats.BranchElems
		stats.StorageStaleDeleted += trieStats.StaleNodesDeleted

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
				return [32]byte{}, nil, err
			}
			stats.StorageTrieWrites++
		}

		if trace != nil || verifyStorageIncremental {
			fullRoot := computeFullStorageRoot(tx, db, addrHash)
			if trace != nil {
				trace.Report(root, fullRoot)
			}
			if verifyStorageIncremental && root != fullRoot {
				osr := oldStorageRoots[addrHash]
				log.Printf("  STORAGE INCREMENTAL BUG acct %x: incremental=%x full=%x changedSlots=%d oldRoot=%x",
					addrHash, root[:8], fullRoot[:8], len(slotHashes), osr[:8])
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
			return [32]byte{}, nil, err
		}
		if len(val) < 104 {
			continue
		}
		updated := make([]byte, len(val))
		copy(updated, val)
		copy(updated[72:104], correctRoot[:])
		if err := tx.Put(db.HashedAccountState, addrHash[:], updated, 0); err != nil {
			return [32]byte{}, nil, err
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
	root, updates, trieStats, err := computeTrieRoot(tx, db.AccountTrie, db.HashedAccountState, nil, accountPrefixSet, false, nil)
	if err != nil {
		return [32]byte{}, nil, err
	}
	stats.AccountLeafElems += trieStats.LeafElems
	stats.AccountBranchElems += trieStats.BranchElems
	stats.AccountStaleDeleted += trieStats.StaleNodesDeleted

	// Persist account trie branch node updates. Skip unchanged.
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
			return [32]byte{}, nil, err
		}
		stats.AccountTrieWrites++
	}

	if os.Getenv("TRACE_ACCOUNT_ROOT") != "" {
		fullAccountRoot, err := computeFullAccountRoot(tx, db)
		if err != nil {
			return [32]byte{}, nil, err
		}
		if root != fullAccountRoot {
			log.Printf("  ACCOUNT INCREMENTAL BUG: incremental=%x full=%x changedAccounts=%d storageRoots=%d",
				root[:8], fullAccountRoot[:8], len(changedAccounts), len(storageRoots))
			limit := len(changedAccounts)
			if limit > 25 {
				limit = 25
			}
			for i := 0; i < limit; i++ {
				ha := changedAccounts[i]
				_, storageChanged := storageRoots[ha]
				log.Printf("    changedAccount[%d]=%x storageChanged=%v", i, ha, storageChanged)
			}
		}
	}

	return root, stats, nil
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
	trace *storageTrieTrace,
) ([32]byte, map[string]*intTrie.BranchNodeCompact, trieComputeStats, error) {
	// Open trie cursor (for stored branch nodes).
	trieCursorRaw, err := tx.OpenCursor(trieDBI)
	if err != nil {
		return [32]byte{}, nil, trieComputeStats{}, err
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
		return [32]byte{}, nil, trieComputeStats{}, err
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
	stats := trieComputeStats{}

	for {
		elem, err := iter.Next()
		if err != nil {
			return [32]byte{}, nil, trieComputeStats{}, err
		}
		if elem == nil {
			break
		}
		if trace != nil {
			trace.Record(elem)
		}
		if elem.IsBranch {
			stats.BranchElems++
			hb.AddBranchRef(elem.Key, elem.Ref, elem.ChildNodeStored)
		} else {
			stats.LeafElems++
			hb.AddLeaf(elem.Key, elem.Value)
		}
	}

	updates := hb.Updates()

	// Clean up stale branch nodes: scan stored nodes and delete any that
	// the walker would have visited (under a changed prefix) but aren't in
	// the update set. Without this, old branch nodes accumulate when the trie
	// restructures, and the walker trusts their stale cached hashes.
	prefixSet.Reset()
	deleted, err := deleteStaleNodes(tx, trieDBI, prefix, prefixSet, updates)
	if err != nil {
		return [32]byte{}, nil, trieComputeStats{}, err
	}
	stats.StaleNodesDeleted = deleted

	return hb.Root(), updates, stats, nil
}

type tracedLeaf struct {
	key   intTrie.Nibbles
	value []byte
}

type tracedBranch struct {
	key    intTrie.Nibbles
	ref    []byte
	stored bool
}

type storageTrieTrace struct {
	addrHash       [32]byte
	fullLeaves     []tracedLeaf
	changedLeaves  []intTrie.Nibbles
	emittedLeaves  []tracedLeaf
	cachedBranches []tracedBranch
	sequence       []string
}

func parseTraceStorageAccount() ([32]byte, bool) {
	raw := os.Getenv("TRACE_STORAGE_ACCOUNT")
	if raw == "" {
		return [32]byte{}, false
	}
	if len(raw) >= 2 && raw[:2] == "0x" {
		raw = raw[2:]
	}
	if len(raw) != 64 {
		log.Printf("TRACE_STORAGE_ACCOUNT ignored: need 32-byte hex, got %q", raw)
		return [32]byte{}, false
	}
	buf, err := hex.DecodeString(raw)
	if err != nil {
		log.Printf("TRACE_STORAGE_ACCOUNT ignored: %v", err)
		return [32]byte{}, false
	}
	var out [32]byte
	copy(out[:], buf)
	return out, true
}

func newStorageTrieTrace(
	tx *mdbx.Txn,
	stateDBI mdbx.DBI,
	addrHash [32]byte,
	slotHashes [][32]byte,
) (*storageTrieTrace, error) {
	fullLeaves, err := loadStorageTraceLeaves(tx, stateDBI, addrHash)
	if err != nil {
		return nil, err
	}
	changedLeaves := make([]intTrie.Nibbles, 0, len(slotHashes))
	for _, sh := range slotHashes {
		changedLeaves = append(changedLeaves, intTrie.FromHex(sh[:]))
	}
	sort.Slice(changedLeaves, func(i, j int) bool {
		return changedLeaves[i].Compare(changedLeaves[j]) < 0
	})
	return &storageTrieTrace{
		addrHash:      addrHash,
		fullLeaves:    fullLeaves,
		changedLeaves: changedLeaves,
	}, nil
}

func loadStorageTraceLeaves(tx *mdbx.Txn, stateDBI mdbx.DBI, addrHash [32]byte) ([]tracedLeaf, error) {
	cursor, err := tx.OpenCursor(stateDBI)
	if err != nil {
		return nil, err
	}
	defer cursor.Close()

	var leaves []tracedLeaf
	k, v, err := cursor.Get(addrHash[:], nil, mdbx.SetRange)
	for err == nil && len(k) >= 64 {
		var currentAddr [32]byte
		copy(currentAddr[:], k[:32])
		if currentAddr != addrHash {
			break
		}

		slotHash := make([]byte, 32)
		copy(slotHash, k[32:64])
		valCopy := make([]byte, len(v))
		copy(valCopy, v)
		leaves = append(leaves, tracedLeaf{
			key:   intTrie.FromHex(slotHash),
			value: rlpEncodeBytesForDebug(valCopy),
		})
		k, v, err = cursor.Get(nil, nil, mdbx.Next)
	}
	return leaves, nil
}

func (t *storageTrieTrace) Record(elem *intTrie.TrieElement) {
	if elem == nil {
		return
	}
	if len(t.sequence) < 128 {
		if elem.IsBranch {
			t.sequence = append(t.sequence, "branch:"+elem.Key.String())
		} else {
			t.sequence = append(t.sequence, "leaf:"+elem.Key.String())
		}
	}
	if elem.IsBranch {
		t.cachedBranches = append(t.cachedBranches, tracedBranch{
			key:    elem.Key,
			ref:    append([]byte(nil), elem.Ref...),
			stored: elem.ChildNodeStored,
		})
		return
	}
	valCopy := make([]byte, len(elem.Value))
	copy(valCopy, elem.Value)
	t.emittedLeaves = append(t.emittedLeaves, tracedLeaf{
		key:   elem.Key,
		value: valCopy,
	})
}

func (t *storageTrieTrace) Report(incrementalRoot, fullRoot [32]byte) {
	log.Printf("  TRACE storage acct %x: incremental=%x full=%x fullLeaves=%d emittedLeaves=%d cachedBranches=%d changedLeaves=%d",
		t.addrHash[:8], incrementalRoot[:8], fullRoot[:8], len(t.fullLeaves), len(t.emittedLeaves), len(t.cachedBranches), len(t.changedLeaves))

	emitted := make(map[string]int, len(t.emittedLeaves))
	for _, leaf := range t.emittedLeaves {
		emitted[leaf.key.String()]++
	}

	uncovered := 0
	overlaps := 0
	for _, leaf := range t.fullLeaves {
		emittedCount := emitted[leaf.key.String()]
		cachedCount := 0
		for _, branch := range t.cachedBranches {
			if leaf.key.HasPrefix(branch.key) {
				cachedCount++
			}
		}
		if emittedCount == 0 && cachedCount == 0 {
			uncovered++
			if uncovered <= 10 {
				log.Printf("    UNCOVERED leaf %s", leaf.key.String())
			}
		}
		if emittedCount+cachedCount > 1 {
			overlaps++
			if overlaps <= 10 {
				log.Printf("    OVERLAP leaf %s emitted=%d cached=%d", leaf.key.String(), emittedCount, cachedCount)
			}
		}
	}
	log.Printf("    coverage: uncovered=%d overlaps=%d", uncovered, overlaps)

	if prefix, ok := t.deepestMismatchPrefix(); ok {
		inc := hashIncrementalTraceSubtree(t.emittedLeaves, t.cachedBranches, prefix)
		full := hashTraceSubtree(t.fullLeaves, prefix)
		incRef := refIncrementalTraceSubtree(t.emittedLeaves, t.cachedBranches, prefix)
		fullRef := refTraceSubtree(t.fullLeaves, prefix)
		log.Printf("    deepest mismatch prefix=%s incremental=%x full=%x incRefLen=%d incRef=%x fullRefLen=%d fullRef=%x",
			prefix.String(), inc[:8], full[:8], len(incRef), incRef, len(fullRef), fullRef)
		t.logPrefixElements(prefix)
	}

	suspicious := 0
	for _, branch := range t.cachedBranches {
		fullCount := 0
		for _, leaf := range t.fullLeaves {
			if leaf.key.HasPrefix(branch.key) {
				fullCount++
			}
		}
		changedCount := 0
		for _, leaf := range t.changedLeaves {
			if leaf.HasPrefix(branch.key) {
				changedCount++
			}
		}
		expectedRef := refTraceSubtree(t.fullLeaves, branch.key)
		if changedCount > 0 || !bytes.Equal(expectedRef, branch.ref) {
			suspicious++
			if suspicious <= 25 {
				log.Printf("    BRANCH %s cachedLen=%d cached=%x expectedLen=%d expected=%x fullLeaves=%d changedLeaves=%d stored=%v",
					branch.key.String(), len(branch.ref), branch.ref, len(expectedRef), expectedRef, fullCount, changedCount, branch.stored)
			}
		}
	}

	if len(t.sequence) > 0 {
		limit := len(t.sequence)
		if limit > 40 {
			limit = 40
		}
		for i := 0; i < limit; i++ {
			log.Printf("    seq[%d]=%s", i, t.sequence[i])
		}
	}
}

func (t *storageTrieTrace) deepestMismatchPrefix() (intTrie.Nibbles, bool) {
	prefixes := make(map[string]intTrie.Nibbles)
	prefixes[""] = intTrie.Nibbles{}
	for _, leaf := range t.emittedLeaves {
		for l := 1; l < leaf.key.Len(); l++ {
			p := leaf.key.Prefix(l)
			prefixes[p.String()] = p
		}
	}
	for _, branch := range t.cachedBranches {
		for l := 1; l <= branch.key.Len(); l++ {
			p := branch.key.Prefix(l)
			prefixes[p.String()] = p
		}
	}

	var ordered []intTrie.Nibbles
	for _, prefix := range prefixes {
		ordered = append(ordered, prefix)
	}
	sort.Slice(ordered, func(i, j int) bool {
		if ordered[i].Len() != ordered[j].Len() {
			return ordered[i].Len() > ordered[j].Len()
		}
		return ordered[i].Compare(ordered[j]) < 0
	})

	for _, prefix := range ordered {
		coveredByBroaderBranch := false
		for _, branch := range t.cachedBranches {
			if branch.key.Len() >= prefix.Len() {
				continue
			}
			if prefix.HasPrefix(branch.key) {
				coveredByBroaderBranch = true
				break
			}
		}
		if coveredByBroaderBranch {
			continue
		}
		inc := hashIncrementalTraceSubtree(t.emittedLeaves, t.cachedBranches, prefix)
		full := hashTraceSubtree(t.fullLeaves, prefix)
		if inc != full {
			return prefix, true
		}
	}
	return intTrie.Nibbles{}, false
}

func (t *storageTrieTrace) logPrefixElements(prefix intTrie.Nibbles) {
	count := 0
	for _, branch := range t.cachedBranches {
		if branch.key.HasPrefix(prefix) {
			log.Printf("      prefix branch %s -> rel=%s refLen=%d ref=%x stored=%v", branch.key.String(), branch.key.Slice(prefix.Len(), branch.key.Len()).String(), len(branch.ref), branch.ref, branch.stored)
			count++
			if count >= 20 {
				return
			}
		}
	}
	for _, leaf := range t.fullLeaves {
		if leaf.key.HasPrefix(prefix) {
			log.Printf("      full leaf %s -> rel=%s", leaf.key.String(), leaf.key.Slice(prefix.Len(), leaf.key.Len()).String())
			count++
			if count >= 20 {
				return
			}
		}
	}
	for _, leaf := range t.emittedLeaves {
		if leaf.key.HasPrefix(prefix) {
			log.Printf("      prefix leaf %s -> rel=%s", leaf.key.String(), leaf.key.Slice(prefix.Len(), leaf.key.Len()).String())
			count++
			if count >= 20 {
				return
			}
		}
	}
}

func hashTraceSubtree(leaves []tracedLeaf, prefix intTrie.Nibbles) [32]byte {
	hb := intTrie.NewHashBuilder()
	for _, leaf := range leaves {
		if !leaf.key.HasPrefix(prefix) {
			continue
		}
		hb.AddLeaf(leaf.key.Slice(prefix.Len(), leaf.key.Len()), leaf.value)
	}
	return hb.Root()
}

func hashIncrementalTraceSubtree(
	emittedLeaves []tracedLeaf,
	cachedBranches []tracedBranch,
	prefix intTrie.Nibbles,
) [32]byte {
	return rootForIncrementalTraceSubtree(emittedLeaves, cachedBranches, prefix).Root()
}

func refIncrementalTraceSubtree(
	emittedLeaves []tracedLeaf,
	cachedBranches []tracedBranch,
	prefix intTrie.Nibbles,
) []byte {
	hb := rootForIncrementalTraceSubtree(emittedLeaves, cachedBranches, prefix)
	hb.Root()
	return hb.StackTop()
}

func rootForIncrementalTraceSubtree(
	emittedLeaves []tracedLeaf,
	cachedBranches []tracedBranch,
	prefix intTrie.Nibbles,
) *intTrie.HashBuilder {
	type elem struct {
		key      intTrie.Nibbles
		isBranch bool
		ref      []byte
		value    []byte
	}

	var elems []elem
	for _, branch := range cachedBranches {
		if !branch.key.HasPrefix(prefix) {
			continue
		}
		elems = append(elems, elem{
			key:      branch.key.Slice(prefix.Len(), branch.key.Len()),
			isBranch: true,
			ref:      branch.ref,
		})
	}
	for _, leaf := range emittedLeaves {
		if !leaf.key.HasPrefix(prefix) {
			continue
		}
		elems = append(elems, elem{
			key:   leaf.key.Slice(prefix.Len(), leaf.key.Len()),
			value: leaf.value,
		})
	}

	sort.Slice(elems, func(i, j int) bool {
		return elems[i].key.Compare(elems[j].key) < 0
	})

	hb := intTrie.NewHashBuilder()
	for _, elem := range elems {
		if elem.isBranch {
			hb.AddBranchRef(elem.key, elem.ref, false)
		} else {
			hb.AddLeaf(elem.key, elem.value)
		}
	}
	return hb
}

func refTraceSubtree(leaves []tracedLeaf, prefix intTrie.Nibbles) []byte {
	hb := intTrie.NewHashBuilder()
	for _, leaf := range leaves {
		if !leaf.key.HasPrefix(prefix) {
			continue
		}
		hb.AddLeaf(leaf.key.Slice(prefix.Len(), leaf.key.Len()), leaf.value)
	}
	hb.Root()
	return hb.StackTop()
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
		if prefixSet.ContainsPrefixUnordered(nibblePath) {
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

// computeFullAccountRoot computes the account trie root directly from the
// current HashedAccountState contents in this transaction.
// Any storage-root patching for changed accounts must already be applied.
func computeFullAccountRoot(tx *mdbx.Txn, db *store.DB) ([32]byte, error) {
	acctCursor, err := tx.OpenCursor(db.HashedAccountState)
	if err != nil {
		return [32]byte{}, err
	}
	defer acctCursor.Close()

	acctHB := intTrie.NewHashBuilder()
	k, v, e := acctCursor.Get(nil, nil, mdbx.First)
	for e == nil && len(k) >= 32 {
		valCopy := make([]byte, len(v))
		copy(valCopy, v)

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

func (s *singleLeafSource) SeekTo(key []byte) error {
	return nil
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
