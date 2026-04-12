// diagnose reads the MDBX DB and computes state roots two ways:
// 1. From HashedAccountState + HashedStorageState using our ComputeFullStateRoot
// 2. From HashedAccountState + HashedStorageState using geth's StackTrie (ground truth)
// This helps identify whether the bug is in our trie computation or in the stored data.
package main

import (
	"bytes"
	"encoding/binary"
	"flag"
	"fmt"
	"log"
	"math/bits"
	"runtime"
	"sort"

	corethcore "github.com/ava-labs/avalanchego/graft/coreth/core"
	"github.com/ava-labs/avalanchego/graft/coreth/core/extstate"
	cparams "github.com/ava-labs/avalanchego/graft/coreth/params"
	ccustomtypes "github.com/ava-labs/avalanchego/graft/coreth/plugin/evm/customtypes"
	"github.com/ava-labs/libevm/crypto"
	proposerblock "github.com/ava-labs/avalanchego/vms/proposervm/block"
	ethtypes "github.com/ava-labs/libevm/core/types"
	"github.com/ava-labs/libevm/rlp"
	"github.com/erigontech/mdbx-go/mdbx"

	"block_fetcher/statetrie"
	"block_fetcher/store"
	intTrie "block_fetcher/trie"
)

func init() {
	corethcore.RegisterExtras()
	ccustomtypes.Register()
	extstate.RegisterExtras()
	cparams.RegisterExtras()
}

type slotEntry struct {
	slotHash [32]byte
	value    []byte
}

func main() {
	dbDir := flag.String("db", "data/mainnet-mdbx", "MDBX directory")
	flag.Parse()

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	db, err := store.Open(*dbDir)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer db.Close()

	roTx, err := db.BeginRO()
	if err != nil {
		log.Fatalf("begin RO: %v", err)
	}
	defer roTx.Abort()

	// 1. Read head block
	head, ok := store.GetHeadBlock(roTx, db)
	if !ok {
		log.Fatalf("no head block set")
	}
	log.Printf("Head block: %d", head)

	// 2. Read the expected root for head block
	raw, err := store.GetBlockByNumber(roTx, db, head)
	if err != nil {
		log.Fatalf("read head block %d: %v", head, err)
	}
	ethBlock, err := parseEthBlock(raw)
	if err != nil {
		log.Fatalf("parse block %d: %v", head, err)
	}
	expectedRoot := ethBlock.Header().Root
	log.Printf("Expected root for block %d: %x", head, expectedRoot)

	// 3. Compute full state root from HashedAccountState+HashedStorageState
	//    using our ComputeFullStateRoot
	log.Println("Computing full state root (our ComputeFullStateRoot)...")
	ourFullRoot, err := statetrie.ComputeFullStateRoot(roTx, db)
	if err != nil {
		log.Fatalf("ComputeFullStateRoot: %v", err)
	}
	log.Printf("Our ComputeFullStateRoot: %x", ourFullRoot)

	// 4. Compute via ground-truth StackTrie-like method
	//    Scan HashedStorageState for storage roots, then HashedAccountState for accounts
	log.Println("Computing ground-truth root (HashBuilder from HashedState)...")
	groundRoot := computeGroundTruthRoot(roTx, db)
	log.Printf("Ground-truth root: %x", groundRoot)

	log.Printf("Match: %v", ourFullRoot == groundRoot)

	// 5. Dump AccountTrie root node
	log.Println("Dumping AccountTrie root node...")
	dumpAccountTrieRoot(roTx, db)

	// 6. Verify each root-level child hash by recomputing from leaves
	log.Println("Verifying root-level child hashes...")
	verifyChildHashes(roTx, db)

	// 7. Test: does HashBuilder produce the same root with branches vs all-leaves?
	// Feed the same data two ways: (A) all leaves, (B) cached branches + remaining leaves
	// Both should give the same root at block 1,562,988 (no changes).
	log.Println("Testing HashBuilder: branches+leaves vs all-leaves...")
	testHashBuilderMixing(roTx, db)

	// 8. Also check: are there any accounts with zero storage roots in HashedAccountState
	//    that actually have storage in HashedStorageState?
	log.Println("Checking for accounts with zero storage root but having storage...")
	checkZeroStorageRoots(roTx, db)
}

func computeGroundTruthRoot(tx *mdbx.Txn, db *store.DB) [32]byte {
	// Step 1: Compute storage roots from HashedStorageState
	storageCursor, err := tx.OpenCursor(db.HashedStorageState)
	if err != nil {
		log.Fatalf("open HashedStorageState cursor: %v", err)
	}
	defer storageCursor.Close()

	storageRoots := make(map[[32]byte][32]byte)

	var currentAddr [32]byte
	var slots []slotEntry
	first := true

	k, v, e := storageCursor.Get(nil, nil, mdbx.First)
	for e == nil && len(k) >= 64 {
		var addrHash [32]byte
		copy(addrHash[:], k[:32])

		if !first && addrHash != currentAddr {
			// Flush previous account's storage
			storageRoots[currentAddr] = computeStorageRoot(slots)
			slots = slots[:0]
		}
		first = false
		currentAddr = addrHash

		var slotHash [32]byte
		copy(slotHash[:], k[32:64])
		val := make([]byte, len(v))
		copy(val, v)
		slots = append(slots, slotEntry{slotHash: slotHash, value: val})

		k, v, e = storageCursor.Get(nil, nil, mdbx.Next)
	}
	if len(slots) > 0 {
		storageRoots[currentAddr] = computeStorageRoot(slots)
	}

	log.Printf("  Storage roots computed for %d accounts", len(storageRoots))

	// Step 2: Scan HashedAccountState, build account trie
	acctCursor, err := tx.OpenCursor(db.HashedAccountState)
	if err != nil {
		log.Fatalf("open HashedAccountState cursor: %v", err)
	}
	defer acctCursor.Close()

	type acctKV struct {
		hashedAddr [32]byte
		rlp        []byte
	}
	var accts []acctKV

	k, v, e = acctCursor.Get(nil, nil, mdbx.First)
	for e == nil && len(k) >= 32 {
		var ha [32]byte
		copy(ha[:], k[:32])

		valCopy := make([]byte, len(v))
		copy(valCopy, v)

		// Patch storage root from computed values
		if len(valCopy) >= 104 {
			if sr, ok := storageRoots[ha]; ok {
				copy(valCopy[72:104], sr[:])
			}
		}

		// Encode as RLP
		rlpData := encodeAccountRLP(valCopy)
		accts = append(accts, acctKV{hashedAddr: ha, rlp: rlpData})

		k, v, e = acctCursor.Get(nil, nil, mdbx.Next)
	}

	// Sort by hashedAddr (should already be sorted from MDBX, but just in case)
	sort.Slice(accts, func(i, j int) bool {
		for x := 0; x < 32; x++ {
			if accts[i].hashedAddr[x] < accts[j].hashedAddr[x] {
				return true
			}
			if accts[i].hashedAddr[x] > accts[j].hashedAddr[x] {
				return false
			}
		}
		return false
	})

	hb := intTrie.NewHashBuilder()
	for _, a := range accts {
		hb.AddLeaf(intTrie.FromHex(a.hashedAddr[:]), a.rlp)
	}

	log.Printf("  %d accounts in trie", len(accts))
	return hb.Root()
}

func computeStorageRoot(slots []slotEntry) [32]byte {
	// Sort by slotHash
	sort.Slice(slots, func(i, j int) bool {
		for x := 0; x < 32; x++ {
			if slots[i].slotHash[x] < slots[j].slotHash[x] {
				return true
			}
			if slots[i].slotHash[x] > slots[j].slotHash[x] {
				return false
			}
		}
		return false
	})

	hb := intTrie.NewHashBuilder()
	for _, s := range slots {
		hb.AddLeaf(intTrie.FromHex(s.slotHash[:]), rlpEncodeBytes(s.value))
	}
	return hb.Root()
}

func rlpEncodeBytes(val []byte) []byte {
	if len(val) == 1 && val[0] <= 0x7f {
		return []byte{val[0]}
	}
	if len(val) <= 55 {
		out := make([]byte, 1+len(val))
		out[0] = 0x80 + byte(len(val))
		copy(out[1:], val)
		return out
	}
	return val
}

func encodeAccountRLP(val []byte) []byte {
	if len(val) < 104 {
		return nil
	}

	nonce := binary.BigEndian.Uint64(val[0:8])
	balance := val[8:40]
	codeHash := val[40:72]
	storageRoot := val[72:104]
	isMultiCoin := len(val) >= 105 && val[104] != 0

	// Use same encoding as AccountLeafSource
	var buf [160]byte
	off := 3

	off += rlpPutUint64(buf[off:], nonce)

	trimBal := trimLeadingZeros(balance)
	off += rlpPutBytes(buf[off:], trimBal)

	off += rlpPutFixedBytes(buf[off:], storageRoot)
	off += rlpPutFixedBytes(buf[off:], codeHash)

	if isMultiCoin {
		buf[off] = 0x01
	} else {
		buf[off] = 0x80
	}
	off++

	payloadLen := off - 3
	var start int
	if payloadLen <= 55 {
		start = 2
		buf[start] = 0xc0 + byte(payloadLen)
	} else {
		lenBytes := uintBytes(uint64(payloadLen))
		start = 3 - 1 - lenBytes
		buf[start] = 0xf7 + byte(lenBytes)
		for i := lenBytes; i > 0; i-- {
			buf[start+i] = byte(payloadLen >> (8 * (lenBytes - i)))
		}
	}
	out := make([]byte, off-start)
	copy(out, buf[start:off])
	return out
}

func rlpPutUint64(dst []byte, v uint64) int {
	if v == 0 {
		dst[0] = 0x80
		return 1
	}
	if v <= 0x7f {
		dst[0] = byte(v)
		return 1
	}
	n := uintBytes(v)
	dst[0] = 0x80 + byte(n)
	for i := n; i > 0; i-- {
		dst[i] = byte(v)
		v >>= 8
	}
	return 1 + n
}

func rlpPutBytes(dst []byte, b []byte) int {
	if len(b) == 0 {
		dst[0] = 0x80
		return 1
	}
	if len(b) == 1 && b[0] <= 0x7f {
		dst[0] = b[0]
		return 1
	}
	if len(b) <= 55 {
		dst[0] = 0x80 + byte(len(b))
		copy(dst[1:], b)
		return 1 + len(b)
	}
	lenBytes := uintBytes(uint64(len(b)))
	dst[0] = 0xb7 + byte(lenBytes)
	for i := lenBytes; i > 0; i-- {
		dst[i] = byte(len(b) >> (8 * (lenBytes - i)))
	}
	copy(dst[1+lenBytes:], b)
	return 1 + lenBytes + len(b)
}

func rlpPutFixedBytes(dst []byte, b []byte) int {
	dst[0] = 0xa0
	copy(dst[1:], b[:32])
	return 33
}

func uintBytes(v uint64) int {
	bits := 0
	for v > 0 {
		bits++
		v >>= 8
	}
	return bits
}

func trimLeadingZeros(b []byte) []byte {
	for len(b) > 0 && b[0] == 0 {
		b = b[1:]
	}
	return b
}

func checkZeroStorageRoots(tx *mdbx.Txn, db *store.DB) {
	var zeroRoot [32]byte
	emptyRoot := [32]byte{
		0x56, 0xe8, 0x1f, 0x17, 0x1b, 0xcc, 0x55, 0xa6,
		0xff, 0x83, 0x45, 0xe6, 0x92, 0xc0, 0xf8, 0x6e,
		0x5b, 0x48, 0xe0, 0x1b, 0x99, 0x6c, 0xad, 0xc0,
		0x01, 0x62, 0x2f, 0xb5, 0xe3, 0x63, 0xb4, 0x21,
	}

	// Collect all addrHashes that have storage
	storageCursor, err := tx.OpenCursor(db.HashedStorageState)
	if err != nil {
		log.Fatalf("open cursor: %v", err)
	}
	defer storageCursor.Close()

	hasStorage := make(map[[32]byte]int) // addrHash → count of slots
	k, _, e := storageCursor.Get(nil, nil, mdbx.First)
	for e == nil && len(k) >= 64 {
		var ha [32]byte
		copy(ha[:], k[:32])
		hasStorage[ha]++
		k, _, e = storageCursor.Get(nil, nil, mdbx.Next)
	}
	storageCursor.Close()

	// Check HashedAccountState for accounts with zero storage root that have storage
	acctCursor, err := tx.OpenCursor(db.HashedAccountState)
	if err != nil {
		log.Fatalf("open cursor: %v", err)
	}
	defer acctCursor.Close()

	zeroRootCount := 0
	badCount := 0
	k, v, e := acctCursor.Get(nil, nil, mdbx.First)
	for e == nil && len(k) >= 32 {
		if len(v) >= 104 {
			var ha [32]byte
			copy(ha[:], k[:32])
			var sr [32]byte
			copy(sr[:], v[72:104])

			if sr == zeroRoot {
				zeroRootCount++
				if count, ok := hasStorage[ha]; ok && count > 0 {
					badCount++
					if badCount <= 10 {
						log.Printf("  BAD: account %x has zero storage root but %d storage slots in HashedStorageState", ha[:8], count)
						// Also check what address this maps to
						addr := reverseAddrHash(tx, db, ha)
						if addr != nil {
							log.Printf("       address: %x", addr)
						}
					}
				}
			} else if sr == emptyRoot {
				// EmptyRoot is fine — it's the trie hash of empty state
			}
		}
		k, v, e = acctCursor.Get(nil, nil, mdbx.Next)
	}

	log.Printf("  Total accounts with zero storage root: %d", zeroRootCount)
	log.Printf("  Of those, accounts with actual storage in HashedStorageState: %d", badCount)
}

// reverseAddrHash tries to find the original address for a hashed address
// by scanning AccountState.
func reverseAddrHash(tx *mdbx.Txn, db *store.DB, targetHash [32]byte) []byte {
	cursor, err := tx.OpenCursor(db.AccountState)
	if err != nil {
		return nil
	}
	defer cursor.Close()

	k, _, e := cursor.Get(nil, nil, mdbx.First)
	for e == nil && len(k) >= 20 {
		hash := crypto.Keccak256(k[:20])
		var ha [32]byte
		copy(ha[:], hash)
		if ha == targetHash {
			result := make([]byte, 20)
			copy(result, k[:20])
			return result
		}
		k, _, e = cursor.Get(nil, nil, mdbx.Next)
	}
	return nil
}

func verifyChildHashes(tx *mdbx.Txn, db *store.DB) {
	// Read root branch node
	cursor, err := tx.OpenCursor(db.AccountTrie)
	if err != nil {
		log.Printf("  error: %v", err)
		return
	}
	_, v, err := cursor.Get(nil, nil, mdbx.First)
	if err != nil {
		log.Printf("  error: %v", err)
		cursor.Close()
		return
	}
	rootNode, _ := intTrie.DecodeBranchNode(v)
	cursor.Close()

	// Read all accounts from HashedAccountState and compute storage roots
	storageCursor, _ := tx.OpenCursor(db.HashedStorageState)
	storageRoots := make(map[[32]byte][32]byte)
	var curAddr [32]byte
	var curSlots []slotEntry
	first := true
	sk, sv, se := storageCursor.Get(nil, nil, mdbx.First)
	for se == nil && len(sk) >= 64 {
		var ah [32]byte
		copy(ah[:], sk[:32])
		if !first && ah != curAddr {
			storageRoots[curAddr] = computeStorageRoot(curSlots)
			curSlots = curSlots[:0]
		}
		first = false
		curAddr = ah
		var sh [32]byte
		copy(sh[:], sk[32:64])
		val := make([]byte, len(sv))
		copy(val, sv)
		curSlots = append(curSlots, slotEntry{slotHash: sh, value: val})
		sk, sv, se = storageCursor.Get(nil, nil, mdbx.Next)
	}
	if len(curSlots) > 0 {
		storageRoots[curAddr] = computeStorageRoot(curSlots)
	}
	storageCursor.Close()

	// For each root-level nibble, compute the subtree hash from leaves
	acctCursor, _ := tx.OpenCursor(db.HashedAccountState)
	defer acctCursor.Close()

	// Group accounts by first nibble
	type acctKV struct {
		hashedAddr [32]byte
		rlp        []byte
	}
	nibbleGroups := make(map[byte][]acctKV)

	ak, av, ae := acctCursor.Get(nil, nil, mdbx.First)
	for ae == nil && len(ak) >= 32 {
		var ha [32]byte
		copy(ha[:], ak[:32])
		valCopy := make([]byte, len(av))
		copy(valCopy, av)
		// Patch storage root
		if len(valCopy) >= 104 {
			if sr, ok := storageRoots[ha]; ok {
				copy(valCopy[72:104], sr[:])
			}
		}
		rlpData := encodeAccountRLP(valCopy)
		firstNibble := ha[0] >> 4
		nibbleGroups[firstNibble] = append(nibbleGroups[firstNibble], acctKV{hashedAddr: ha, rlp: rlpData})
		ak, av, ae = acctCursor.Get(nil, nil, mdbx.Next)
	}

	// For each nibble, compute the exact child ref the root should embed.
	mismatches := 0
	for nibble := byte(0); nibble < 16; nibble++ {
		group := nibbleGroups[nibble]
		// Sort by hashed address (should already be sorted but just in case)
		sort.Slice(group, func(i, j int) bool {
			for x := 0; x < 32; x++ {
				if group[i].hashedAddr[x] < group[j].hashedAddr[x] {
					return true
				}
				if group[i].hashedAddr[x] > group[j].hashedAddr[x] {
					return false
				}
			}
			return false
		})

		hb := intTrie.NewHashBuilder()
		for _, a := range group {
			hb.AddLeaf(intTrie.FromHex(a.hashedAddr[:]).Slice(1, 64), a.rlp)
		}
		hb.Root()
		computedRef := hb.StackTop()

		// Compare with the exact cached ref from the root node.
		cachedRef := childRefForNibble(rootNode, nibble)

		match := bytes.Equal(computedRef, cachedRef)
		if !match {
			mismatches++
			log.Printf("  [%x] MISMATCH! computedRef=%x cachedRef=%x (%d accounts)",
				nibble, previewRef(computedRef), previewRef(cachedRef), len(group))
		} else {
			log.Printf("  [%x] OK ref=%x (%d accounts)", nibble, previewRef(computedRef), len(group))
		}
	}
	log.Printf("  Total mismatches: %d", mismatches)
}

func testHashBuilderMixing(tx *mdbx.Txn, db *store.DB) {
	// Read root branch node to get cached hashes
	cursor, err := tx.OpenCursor(db.AccountTrie)
	if err != nil {
		log.Printf("  error: %v", err)
		return
	}
	_, v, err := cursor.Get(nil, nil, mdbx.First)
	if err != nil {
		cursor.Close()
		log.Printf("  error: %v", err)
		return
	}
	rootNode, _ := intTrie.DecodeBranchNode(v)
	cursor.Close()

	// Read all accounts from HashedAccountState with patched storage roots
	storageCursor, _ := tx.OpenCursor(db.HashedStorageState)
	storageRoots2 := make(map[[32]byte][32]byte)
	var ca2 [32]byte
	var cs2 []slotEntry
	f2 := true
	sk2, sv2, se2 := storageCursor.Get(nil, nil, mdbx.First)
	for se2 == nil && len(sk2) >= 64 {
		var ah [32]byte
		copy(ah[:], sk2[:32])
		if !f2 && ah != ca2 {
			storageRoots2[ca2] = computeStorageRoot(cs2)
			cs2 = cs2[:0]
		}
		f2 = false
		ca2 = ah
		var sh [32]byte
		copy(sh[:], sk2[32:64])
		val := make([]byte, len(sv2))
		copy(val, sv2)
		cs2 = append(cs2, slotEntry{slotHash: sh, value: val})
		sk2, sv2, se2 = storageCursor.Get(nil, nil, mdbx.Next)
	}
	if len(cs2) > 0 {
		storageRoots2[ca2] = computeStorageRoot(cs2)
	}
	storageCursor.Close()

	type acctKV struct {
		hashedAddr [32]byte
		rlp        []byte
	}
	var allAccts []acctKV

	acctCursor, _ := tx.OpenCursor(db.HashedAccountState)
	ak, av, ae := acctCursor.Get(nil, nil, mdbx.First)
	for ae == nil && len(ak) >= 32 {
		var ha [32]byte
		copy(ha[:], ak[:32])
		valCopy := make([]byte, len(av))
		copy(valCopy, av)
		if len(valCopy) >= 104 {
			if sr, ok := storageRoots2[ha]; ok {
				copy(valCopy[72:104], sr[:])
			}
		}
		rlpData := encodeAccountRLP(valCopy)
		allAccts = append(allAccts, acctKV{hashedAddr: ha, rlp: rlpData})
		ak, av, ae = acctCursor.Get(nil, nil, mdbx.Next)
	}
	acctCursor.Close()

	log.Printf("  %d total accounts loaded", len(allAccts))

	// Method A: All leaves, no branches
	hbA := intTrie.NewHashBuilder()
	for _, a := range allAccts {
		hbA.AddLeaf(intTrie.FromHex(a.hashedAddr[:]), a.rlp)
	}
	rootA := hbA.Root()

	// Method B: Use cached root-level branches for some subtrees, leaves for others.
	// Simulate what the incremental path does: use branches for subtrees [0]-[5],[7]-[d]
	// and leaves for [6], [e], [f].
	changedNibbles := map[byte]bool{6: true, 0xe: true, 0xf: true}

	// Build the elements in sorted order (same as NodeIter would produce)
	hbB := intTrie.NewHashBuilder()
	leafIdx := 0

	for nibble := byte(0); nibble < 16; nibble++ {
		if rootNode.StateMask&(1<<nibble) == 0 {
			continue
		}

		if !changedNibbles[nibble] {
			// Use the exact cached child ref as the branch boundary.
			if cachedRef := childRefForNibble(rootNode, nibble); cachedRef != nil {
				branchKey := intTrie.Nibbles{}.Append(nibble)
				hbB.AddBranchRef(branchKey, cachedRef, false)
			}
		}

		if changedNibbles[nibble] {
			// Add all leaves for this subtree
			for leafIdx < len(allAccts) {
				firstNib := allAccts[leafIdx].hashedAddr[0] >> 4
				if firstNib < nibble {
					leafIdx++
					continue
				}
				if firstNib > nibble {
					break
				}
				hbB.AddLeaf(intTrie.FromHex(allAccts[leafIdx].hashedAddr[:]), allAccts[leafIdx].rlp)
				leafIdx++
			}
		} else {
			// Skip leaves for this subtree (they're covered by the branch)
			for leafIdx < len(allAccts) && allAccts[leafIdx].hashedAddr[0]>>4 == nibble {
				leafIdx++
			}
		}
	}
	rootB := hbB.Root()

	log.Printf("  Method A (all leaves):       %x", rootA)
	log.Printf("  Method B (branches+leaves):  %x", rootB)
	log.Printf("  Match: %v", rootA == rootB)
}

func dumpAccountTrieRoot(tx *mdbx.Txn, db *store.DB) {
	cursor, err := tx.OpenCursor(db.AccountTrie)
	if err != nil {
		log.Printf("  error opening AccountTrie cursor: %v", err)
		return
	}
	defer cursor.Close()

	// Read root node (empty key or shortest key)
	k, v, err := cursor.Get(nil, nil, mdbx.First)
	if err != nil {
		log.Printf("  no AccountTrie nodes found")
		return
	}

	log.Printf("  Root node key=%x (%d bytes), value=%d bytes", k, len(k), len(v))
	node, err := intTrie.DecodeBranchNode(v)
	if err != nil {
		log.Printf("  decode error: %v", err)
		return
	}
	log.Printf("  StateMask: %016b", node.StateMask)
	log.Printf("  TreeMask:  %016b", node.TreeMask)
	log.Printf("  RefMask:   %016b", node.RefMask)
	if node.RootHash != nil {
		log.Printf("  RootHash:  %x", node.RootHash[:8])
	}
	log.Printf("  Refs (%d):", len(node.Refs))
	for nibble := 0; nibble < 16; nibble++ {
		sm := node.StateMask&(1<<nibble) != 0
		tm := node.TreeMask&(1<<nibble) != 0
		rm := node.RefMask&(1<<nibble) != 0
		if sm || tm || rm {
			refStr := "-"
			if rm {
				refStr = fmt.Sprintf("%x", previewRef(childRefForNibble(node, byte(nibble))))
			}
			log.Printf("    [%x] state=%v tree=%v ref=%v → %s", nibble, sm, tm, rm, refStr)
		}
	}

	// Count total AccountTrie nodes and check specific paths
	count := 0
	k, _, err = cursor.Get(nil, nil, mdbx.First)
	for err == nil {
		count++
		if count <= 5 || (len(k) >= 2 && k[0] == 1) {
			nibPath := intTrie.Unpack(k)
			log.Printf("    node #%d: key=%x nibbles=%s len=%d", count, k, nibPath.String(), nibPath.Len())
		}
		k, _, err = cursor.Get(nil, nil, mdbx.Next)
	}
	log.Printf("  Total AccountTrie nodes: %d", count)

	// Check if nodes exist at specific 1-nibble paths (6, e, f)
	for _, nibble := range []byte{0x6, 0xe, 0xf} {
		path := intTrie.Nibbles{}.Append(nibble)
		packed := path.Pack()
		k, v, err := cursor.Get(packed, nil, mdbx.SetRange)
		if err != nil {
			log.Printf("  Seek [%x]: not found (error)", nibble)
			continue
		}
		foundPath := intTrie.Unpack(k)
		if foundPath.Equal(path) {
			subNode, _ := intTrie.DecodeBranchNode(v)
			log.Printf("  Seek [%x]: FOUND! key=%x state=%016b tree=%016b ref=%016b refs=%d",
				nibble, k, subNode.StateMask, subNode.TreeMask, subNode.RefMask, len(subNode.Refs))
		} else {
			log.Printf("  Seek [%x]: missed (found key=%x nibbles=%s)", nibble, k, foundPath.String())
		}
	}
}

func childRefForNibble(node *intTrie.BranchNodeCompact, nibble byte) []byte {
	if node == nil || node.RefMask&(1<<nibble) == 0 {
		return nil
	}
	idx := bits.OnesCount16(node.RefMask & ((1 << nibble) - 1))
	if idx >= len(node.Refs) {
		return nil
	}
	ref := make([]byte, len(node.Refs[idx]))
	copy(ref, node.Refs[idx])
	return ref
}

func previewRef(ref []byte) []byte {
	if len(ref) <= 8 {
		return ref
	}
	return ref[:8]
}

func parseEthBlock(raw []byte) (*ethtypes.Block, error) {
	if blk, err := proposerblock.ParseWithoutVerification(raw); err == nil {
		ethBlock := new(ethtypes.Block)
		if err := rlp.DecodeBytes(blk.Block(), ethBlock); err != nil {
			return nil, fmt.Errorf("decode inner eth block: %w", err)
		}
		return ethBlock, nil
	}
	_, _, rest, err := rlp.Split(raw)
	if err != nil {
		return nil, fmt.Errorf("rlp split: %w", err)
	}
	rawBlock := raw[:len(raw)-len(rest)]
	ethBlock := new(ethtypes.Block)
	if err := rlp.DecodeBytes(rawBlock, ethBlock); err != nil {
		return nil, fmt.Errorf("decode pre-fork eth block: %w", err)
	}
	return ethBlock, nil
}
