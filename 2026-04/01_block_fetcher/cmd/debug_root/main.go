package main

import (
	"fmt"
	"log"
	"runtime"
	"sort"

	cparams "github.com/ava-labs/avalanchego/graft/coreth/params"
	ccustomtypes "github.com/ava-labs/avalanchego/graft/coreth/plugin/evm/customtypes"
	"github.com/ava-labs/libevm/common"
	"github.com/ava-labs/libevm/core/rawdb"
	"github.com/ava-labs/libevm/core/types"
	"github.com/ava-labs/libevm/crypto"
	"github.com/ava-labs/libevm/rlp"
	libtrie "github.com/ava-labs/libevm/trie"
	"github.com/ava-labs/libevm/triedb"
	"github.com/erigontech/mdbx-go/mdbx"
	"github.com/holiman/uint256"

	"block_fetcher/store"
	"block_fetcher/trie"
)

type storageEntry struct {
	addr [20]byte
	slot [32]byte
	val  []byte
}

func main() {
	cparams.RegisterExtras()
	ccustomtypes.Register()

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	db, err := store.Open("data/mainnet-mdbx")
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer db.Close()

	roTx, err := db.BeginRO()
	if err != nil {
		log.Fatalf("begin RO: %v", err)
	}
	defer roTx.Abort()

	// Read all accounts
	type acctEntry struct {
		addr     [20]byte
		nonce    uint64
		balance  [32]byte
		codeHash [32]byte
	}
	var accounts []acctEntry

	acctCursor, err := roTx.OpenCursor(db.AccountState)
	if err != nil {
		log.Fatalf("open cursor: %v", err)
	}
	k, v, err := acctCursor.Get(nil, nil, mdbx.First)
	for err == nil && len(k) >= 20 {
		var addr [20]byte
		copy(addr[:], k[:20])
		acct := store.DecodeAccount(v)
		accounts = append(accounts, acctEntry{
			addr:     addr,
			nonce:    acct.Nonce,
			balance:  acct.Balance,
			codeHash: acct.CodeHash,
		})
		k, v, err = acctCursor.Get(nil, nil, mdbx.Next)
	}
	acctCursor.Close()

	// Read all storage
	var allStorage []storageEntry

	storCursor, err := roTx.OpenCursor(db.StorageState)
	if err != nil {
		log.Fatalf("open storage cursor: %v", err)
	}
	k, v, err = storCursor.Get(nil, nil, mdbx.First)
	for err == nil && len(k) >= 52 {
		var addr [20]byte
		var slot [32]byte
		copy(addr[:], k[:20])
		copy(slot[:], k[20:52])
		val := make([]byte, len(v))
		copy(val, v)
		allStorage = append(allStorage, storageEntry{addr: addr, slot: slot, val: val})
		k, v, err = storCursor.Get(nil, nil, mdbx.Next)
	}
	storCursor.Close()

	fmt.Printf("Accounts: %d, Storage entries: %d\n", len(accounts), len(allStorage))

	// Compute storage roots using geth's trie
	memdb := rawdb.NewMemoryDatabase()
	trieDB := triedb.NewDatabase(memdb, nil)

	storageRoots := make(map[[20]byte]common.Hash)
	seen := make(map[[20]byte]bool)
	for _, s := range allStorage {
		if !seen[s.addr] {
			seen[s.addr] = true
			t := libtrie.NewEmpty(trieDB)
			for _, s2 := range allStorage {
				if s2.addr == s.addr {
					hashedKey := crypto.Keccak256(s2.slot[:])
					t.Update(hashedKey, s2.val)
				}
			}
			storageRoots[s.addr] = t.Hash()
		}
	}

	// Compute account root using geth's trie
	gethAcctTrie := libtrie.NewEmpty(trieDB)
	for _, a := range accounts {
		sr := common.Hash(trie.EmptyRootHash)
		if r, ok := storageRoots[a.addr]; ok {
			sr = r
		}
		sa := types.StateAccount{
			Nonce:    a.nonce,
			Balance:  new(uint256.Int).SetBytes32(a.balance[:]),
			Root:     sr,
			CodeHash: a.codeHash[:],
		}
		encoded, _ := rlp.EncodeToBytes(&sa)
		hashedAddr := crypto.Keccak256(a.addr[:])
		gethAcctTrie.Update(hashedAddr, encoded)

		fmt.Printf("  ACCT %x nonce=%d bal=%x storRoot=%x rlpLen=%d rlp=%x\n",
			a.addr, a.nonce, a.balance, sr, len(encoded), encoded)
	}
	gethRoot := gethAcctTrie.Hash()

	// Compute using our HashBuilder
	type kv struct {
		key [32]byte
		val []byte
	}
	var pairs []kv
	for _, a := range accounts {
		sr := trie.EmptyRootHash
		if r, ok := storageRoots[a.addr]; ok {
			sr = [32]byte(r)
		}
		sa := types.StateAccount{
			Nonce:    a.nonce,
			Balance:  new(uint256.Int).SetBytes32(a.balance[:]),
			Root:     common.Hash(sr),
			CodeHash: a.codeHash[:],
		}
		encoded, _ := rlp.EncodeToBytes(&sa)
		hashedAddr := crypto.Keccak256Hash(a.addr[:])
		pairs = append(pairs, kv{key: hashedAddr, val: encoded})
	}
	sort.Slice(pairs, func(i, j int) bool {
		for x := 0; x < 32; x++ {
			if pairs[i].key[x] < pairs[j].key[x] {
				return true
			}
			if pairs[i].key[x] > pairs[j].key[x] {
				return false
			}
		}
		return false
	})

	hb := trie.NewHashBuilder()
	for _, p := range pairs {
		hb.AddLeaf(trie.FromHex(p.key[:]), p.val)
	}
	ourRoot := hb.Root()

	// Also compute the root that ComputeStateRoot would produce
	computedRoot, _, err := trie.ComputeStateRoot(roTx, db, nil)
	if err != nil {
		log.Printf("ComputeStateRoot error: %v", err)
	}

	fmt.Printf("\ngeth trie root:        %x\n", gethRoot)
	fmt.Printf("our HashBuilder root:  %x\n", ourRoot)
	fmt.Printf("ComputeStateRoot:      %x\n", computedRoot)
	fmt.Printf("\ngeth == ours?    %v\n", gethRoot == common.Hash(ourRoot))
	fmt.Printf("geth == compute? %v\n", gethRoot == common.Hash(computedRoot))
}
