package main

import (
	"bytes"
	"encoding/binary"
	"log"
	"runtime"

	"block_fetcher/store"
	intTrie "block_fetcher/trie"

	"github.com/erigontech/mdbx-go/mdbx"
)

var emptyRootHash = [32]byte{
	0x56, 0xe8, 0x1f, 0x17, 0x1b, 0xcc, 0x55, 0xa6,
	0xff, 0x83, 0x45, 0xe6, 0x92, 0xc0, 0xf8, 0x6e,
	0x5b, 0x48, 0xe0, 0x1b, 0x99, 0x6c, 0xad, 0xc0,
	0x01, 0x62, 0x2f, 0xb5, 0xe3, 0x63, 0xb4, 0x21,
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

func main() {
	db, err := store.Open("data/mainnet-mdbx")
	if err != nil {
		log.Fatalf("open db: %v", err)
	}

	// Step 1: Read-only scan to compute all storage roots.
	log.Printf("Step 1: Computing storage roots from HashedStorageState...")
	roTx, err := db.BeginRO()
	if err != nil {
		log.Fatalf("begin RO: %v", err)
	}

	storageCursor, err := roTx.OpenCursor(db.HashedStorageState)
	if err != nil {
		log.Fatalf("open cursor: %v", err)
	}

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
		hb.AddLeaf(intTrie.FromHex(slotHash), rlpEncodeBytes(valCopy))

		k, v, e = storageCursor.Get(nil, nil, mdbx.Next)
	}
	if hb != nil {
		storageRoots[currentAddr] = hb.Root()
	}
	storageCursor.Close()

	log.Printf("  Computed storage roots for %d accounts", len(storageRoots))

	// Step 2: Find accounts with wrong storage roots.
	acctCursor, err := roTx.OpenCursor(db.HashedAccountState)
	if err != nil {
		log.Fatalf("open acct cursor: %v", err)
	}

	type repair struct {
		addrHash [32]byte
		correct  [32]byte
	}
	var repairs []repair

	k, v, e = acctCursor.Get(nil, nil, mdbx.First)
	for e == nil && len(k) >= 32 {
		if len(v) >= 104 {
			var ha [32]byte
			copy(ha[:], k[:32])
			storedSR := v[72:104]

			expectedSR := emptyRootHash
			if sr, ok := storageRoots[ha]; ok {
				expectedSR = sr
			}

			if !bytes.Equal(storedSR, expectedSR[:]) {
				repairs = append(repairs, repair{addrHash: ha, correct: expectedSR})
			}
		}
		k, v, e = acctCursor.Get(nil, nil, mdbx.Next)
	}
	acctCursor.Close()
	roTx.Abort()

	log.Printf("  Found %d accounts with wrong storage roots", len(repairs))
	if len(repairs) == 0 {
		log.Printf("  Nothing to repair!")
		return
	}

	// Show head block.
	roTx2, _ := db.BeginRO()
	headBytes, _ := roTx2.Get(db.Metadata, []byte("head_block"))
	if len(headBytes) >= 8 {
		head := binary.BigEndian.Uint64(headBytes)
		log.Printf("  Head block: %d", head)
	}
	roTx2.Abort()

	// Step 3: Write repairs.
	log.Printf("Step 3: Patching %d accounts...", len(repairs))
	runtime.LockOSThread()
	rwTx, err := db.BeginRW()
	if err != nil {
		log.Fatalf("begin RW: %v", err)
	}

	for _, r := range repairs {
		val, err := rwTx.Get(db.HashedAccountState, r.addrHash[:])
		if err != nil {
			continue
		}
		if len(val) < 104 {
			continue
		}
		updated := make([]byte, len(val))
		copy(updated, val)
		copy(updated[72:104], r.correct[:])
		if err := rwTx.Put(db.HashedAccountState, r.addrHash[:], updated, 0); err != nil {
			rwTx.Abort()
			log.Fatalf("put: %v", err)
		}
	}

	if _, err := rwTx.Commit(); err != nil {
		log.Fatalf("commit: %v", err)
	}
	runtime.UnlockOSThread()
	log.Printf("  Done! Patched %d accounts.", len(repairs))
}
