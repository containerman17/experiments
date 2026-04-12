// debug_hash computes the state root using three methods and compares them
// to diagnose incremental trie hash mismatches.
package main

import (
	"encoding/hex"
	"fmt"
	"log"
	"runtime"
	"sort"

	corethcore "github.com/ava-labs/avalanchego/graft/coreth/core"
	"github.com/ava-labs/avalanchego/graft/coreth/core/extstate"
	cparams "github.com/ava-labs/avalanchego/graft/coreth/params"
	ccustomtypes "github.com/ava-labs/avalanchego/graft/coreth/plugin/evm/customtypes"
	"github.com/ava-labs/libevm/common"
	"github.com/ava-labs/libevm/core/types"
	"github.com/ava-labs/libevm/crypto"
	"github.com/ava-labs/libevm/rlp"
	gethtrie "github.com/ava-labs/libevm/trie"
	"github.com/erigontech/mdbx-go/mdbx"
	"github.com/holiman/uint256"

	"block_fetcher/statetrie"
	"block_fetcher/store"
	intTrie "block_fetcher/trie"
)

func main() {
	// Register libevm extras.
	corethcore.RegisterExtras()
	ccustomtypes.Register()
	extstate.RegisterExtras()
	cparams.RegisterExtras()

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	db, err := store.Open("data/mainnet-mdbx")
	if err != nil {
		log.Fatalf("open MDBX: %v", err)
	}
	defer db.Close()

	tx, err := db.BeginRO()
	if err != nil {
		log.Fatalf("begin RO: %v", err)
	}
	defer tx.Abort()

	// --- Method 1: StackTrie (old, proven correct) ---
	root1, count1, firstEntries1 := method1StackTrie(tx, db)

	// --- Method 2: HashBuilder direct on HashedAccountState ---
	root2, count2, firstEntries2 := method2HashBuilder(tx, db)

	// --- Method 3: Walker + NodeIter ---
	root3, count3, walkerDiag := method3WalkerNodeIter(tx, db)

	// --- Print results ---
	fmt.Println("=== STATE ROOT COMPARISON ===")
	fmt.Printf("Method 1 (StackTrie/old):     %x\n", root1)
	fmt.Printf("Method 2 (HashBuilder):       %x\n", root2)
	fmt.Printf("Method 3 (Walker+NodeIter):   %x\n", root3)
	fmt.Println()
	fmt.Printf("Method 1 == Method 2: %v\n", root1 == root2)
	fmt.Printf("Method 1 == Method 3: %v\n", root1 == root3)
	fmt.Printf("Method 2 == Method 3: %v\n", root2 == root3)

	// Diagnostics if mismatch.
	if root1 != root2 || root1 != root3 {
		fmt.Println()
		fmt.Println("=== DIAGNOSTICS ===")
		fmt.Printf("Account count (AccountState):        %d\n", count1)
		fmt.Printf("Account count (HashedAccountState):  %d\n", count2)
		fmt.Printf("Account count (Method 3 leaves):     %d\n", count3)

		fmt.Println()
		fmt.Println("--- Method 1 first 5 entries (sorted keccak(addr) -> RLP hex) ---")
		for i, e := range firstEntries1 {
			if i >= 5 {
				break
			}
			fmt.Printf("  key=%s value=%s\n", hex.EncodeToString(e.key), hex.EncodeToString(e.value))
		}

		fmt.Println()
		fmt.Println("--- Method 2 first 5 entries (HashedAccountState key -> RLP hex) ---")
		for i, e := range firstEntries2 {
			if i >= 5 {
				break
			}
			fmt.Printf("  key=%s value=%s\n", hex.EncodeToString(e.key), hex.EncodeToString(e.value))
		}

		if root1 != root3 {
			fmt.Println()
			fmt.Println("--- Method 3 Walker diagnostics ---")
			fmt.Printf("  Total walker elements: %d\n", walkerDiag.totalElems)
			fmt.Printf("  Branch elements:       %d\n", walkerDiag.branches)
			fmt.Printf("  Leaf elements:         %d\n", walkerDiag.leaves)
			fmt.Println("  First 10 elements:")
			for i, e := range walkerDiag.firstElems {
				if i >= 10 {
					break
				}
				if e.isBranch {
					fmt.Printf("    [%d] BRANCH key=%s ref=%x childrenInTrie=%v\n",
						i, e.keyStr, e.ref, e.childrenInTrie)
				} else {
					fmt.Printf("    [%d] LEAF   key=%s value=%s\n",
						i, e.keyStr, hex.EncodeToString(e.value))
				}
			}
		}

		// Extra: compare entry-by-entry between Method 1 and Method 2.
		if root1 != root2 && count1 == count2 {
			fmt.Println()
			fmt.Println("--- Entry-by-entry comparison (Method 1 vs Method 2) ---")
			mismatches := 0
			minLen := len(firstEntries1)
			if len(firstEntries2) < minLen {
				minLen = len(firstEntries2)
			}
			for i := 0; i < minLen; i++ {
				e1 := firstEntries1[i]
				e2 := firstEntries2[i]
				keyMatch := hex.EncodeToString(e1.key) == hex.EncodeToString(e2.key)
				valMatch := hex.EncodeToString(e1.value) == hex.EncodeToString(e2.value)
				if !keyMatch || !valMatch {
					fmt.Printf("  MISMATCH at index %d:\n", i)
					fmt.Printf("    M1 key=%s val=%s\n", hex.EncodeToString(e1.key), hex.EncodeToString(e1.value))
					fmt.Printf("    M2 key=%s val=%s\n", hex.EncodeToString(e2.key), hex.EncodeToString(e2.value))
					mismatches++
					if mismatches >= 5 {
						fmt.Println("    ... (showing first 5 mismatches)")
						break
					}
				}
			}
			if mismatches == 0 {
				fmt.Println("  All entries match! Bug must be in feed order or HashBuilder usage.")
			}
		}
	}
}

type kvEntry struct {
	key   []byte
	value []byte
}

// method1StackTrie scans AccountState, converts to StateAccount, sorts by keccak(addr),
// and feeds into geth's StackTrie.
func method1StackTrie(tx *mdbx.Txn, db *store.DB) ([32]byte, int, []kvEntry) {
	cursor, err := tx.OpenCursor(db.AccountState)
	if err != nil {
		log.Fatalf("M1: open AccountState cursor: %v", err)
	}
	defer cursor.Close()

	type entry struct {
		hashedKey [32]byte
		rlpValue  []byte
	}
	var entries []entry

	k, v, err := cursor.Get(nil, nil, mdbx.First)
	for err == nil {
		if len(k) == 20 {
			acct := store.DecodeAccount(v)
			sa := &types.StateAccount{
				Nonce:    acct.Nonce,
				Balance:  new(uint256.Int).SetBytes32(acct.Balance[:]),
				Root:     common.Hash(acct.StorageRoot),
				CodeHash: acct.CodeHash[:],
			}
			encoded, encErr := rlp.EncodeToBytes(sa)
			if encErr != nil {
				log.Fatalf("M1: rlp encode: %v", encErr)
			}
			hashedKey := crypto.Keccak256Hash(k)
			entries = append(entries, entry{hashedKey: [32]byte(hashedKey), rlpValue: encoded})
		}
		k, v, err = cursor.Get(nil, nil, mdbx.Next)
	}
	if !mdbx.IsNotFound(err) && err != nil {
		log.Fatalf("M1: cursor scan: %v", err)
	}

	// Sort by keccak(address).
	sort.Slice(entries, func(i, j int) bool {
		for x := 0; x < 32; x++ {
			if entries[i].hashedKey[x] != entries[j].hashedKey[x] {
				return entries[i].hashedKey[x] < entries[j].hashedKey[x]
			}
		}
		return false
	})

	// Feed into StackTrie.
	st := gethtrie.NewStackTrie(nil)
	for _, e := range entries {
		if err := st.Update(e.hashedKey[:], e.rlpValue); err != nil {
			log.Fatalf("M1: stacktrie update: %v", err)
		}
	}
	root := st.Hash()

	// Collect all entries for diagnostics.
	var kvEntries []kvEntry
	for _, e := range entries {
		keyCopy := make([]byte, 32)
		copy(keyCopy, e.hashedKey[:])
		kvEntries = append(kvEntries, kvEntry{key: keyCopy, value: e.rlpValue})
	}

	return [32]byte(root), len(entries), kvEntries
}

// method2HashBuilder scans HashedAccountState (already keccak-sorted),
// decodes accounts, RLP-encodes, and feeds into our HashBuilder.
func method2HashBuilder(tx *mdbx.Txn, db *store.DB) ([32]byte, int, []kvEntry) {
	cursor, err := tx.OpenCursor(db.HashedAccountState)
	if err != nil {
		log.Fatalf("M2: open HashedAccountState cursor: %v", err)
	}
	defer cursor.Close()

	hb := intTrie.NewHashBuilder()
	var count int
	var kvEntries []kvEntry

	k, v, err := cursor.Get(nil, nil, mdbx.First)
	for err == nil {
		if len(k) == 32 {
			acct := store.DecodeAccount(v)
			sa := &types.StateAccount{
				Nonce:    acct.Nonce,
				Balance:  new(uint256.Int).SetBytes32(acct.Balance[:]),
				Root:     common.Hash(acct.StorageRoot),
				CodeHash: acct.CodeHash[:],
			}
			encoded, encErr := rlp.EncodeToBytes(sa)
			if encErr != nil {
				log.Fatalf("M2: rlp encode: %v", encErr)
			}

			nibbles := intTrie.FromHex(k)
			hb.AddLeaf(nibbles, encoded)
			count++

			keyCopy := make([]byte, 32)
			copy(keyCopy, k)
			kvEntries = append(kvEntries, kvEntry{key: keyCopy, value: encoded})
		}
		k, v, err = cursor.Get(nil, nil, mdbx.Next)
	}
	if !mdbx.IsNotFound(err) && err != nil {
		log.Fatalf("M2: cursor scan: %v", err)
	}

	root := hb.Root()
	return root, count, kvEntries
}

type walkerElemDiag struct {
	keyStr         string
	isBranch       bool
	ref            []byte
	childrenInTrie bool
	value          []byte
}

type walkerDiagnostics struct {
	totalElems int
	branches   int
	leaves     int
	firstElems []walkerElemDiag
}

// method3WalkerNodeIter uses the full incremental path:
// PrefixSet (all keys) + TrieWalker + NodeIter + HashBuilder.
func method3WalkerNodeIter(tx *mdbx.Txn, db *store.DB) ([32]byte, int, walkerDiagnostics) {
	diag := walkerDiagnostics{}

	// Build PrefixSet containing ALL keys from HashedAccountState.
	psb := intTrie.NewPrefixSetBuilder()
	{
		cursor, err := tx.OpenCursor(db.HashedAccountState)
		if err != nil {
			log.Fatalf("M3: open HashedAccountState cursor for prefix set: %v", err)
		}
		k, _, err := cursor.Get(nil, nil, mdbx.First)
		for err == nil {
			if len(k) == 32 {
				psb.AddKey(intTrie.FromHex(k))
			}
			k, _, err = cursor.Get(nil, nil, mdbx.Next)
		}
		if !mdbx.IsNotFound(err) && err != nil {
			log.Fatalf("M3: prefix set scan: %v", err)
		}
		cursor.Close()
	}
	ps := psb.Build()

	// Open cursor on AccountTrie for TrieWalker.
	trieCursor, err := tx.OpenCursor(db.AccountTrie)
	if err != nil {
		log.Fatalf("M3: open AccountTrie cursor: %v", err)
	}
	defer trieCursor.Close()

	walker := intTrie.NewTrieWalker(trieCursor, ps)

	// Open cursor on HashedAccountState for leaf source.
	hashedCursor, err := tx.OpenCursor(db.HashedAccountState)
	if err != nil {
		log.Fatalf("M3: open HashedAccountState cursor: %v", err)
	}
	defer hashedCursor.Close()

	rawLeafSource := intTrie.NewMDBXLeafSource(hashedCursor, nil)
	leafSource := statetrie.NewAccountLeafSource(rawLeafSource)

	iter := intTrie.NewNodeIter(walker, leafSource)
	hb := intTrie.NewHashBuilder()

	var leafCount int
	for {
		elem, err := iter.Next()
		if err != nil {
			log.Fatalf("M3: iter next: %v", err)
		}
		if elem == nil {
			break
		}

		diag.totalElems++
		elemDiag := walkerElemDiag{
			keyStr:   elem.Key.String(),
			isBranch: elem.IsBranch,
		}

		if elem.IsBranch {
			diag.branches++
			if elem.Ref != nil {
				elemDiag.ref = make([]byte, len(elem.Ref))
				copy(elemDiag.ref, elem.Ref)
			}
			elemDiag.childrenInTrie = elem.ChildNodeStored
			hb.AddBranchRef(elem.Key, elem.Ref, elem.ChildNodeStored)
		} else {
			diag.leaves++
			leafCount++
			valCopy := make([]byte, len(elem.Value))
			copy(valCopy, elem.Value)
			elemDiag.value = valCopy
			hb.AddLeaf(elem.Key, elem.Value)
		}

		if len(diag.firstElems) < 20 {
			diag.firstElems = append(diag.firstElems, elemDiag)
		}
	}

	root := hb.Root()
	return root, leafCount, diag
}
