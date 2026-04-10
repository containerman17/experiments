package trie

import (
	"sort"

	"github.com/ava-labs/libevm/common"
	"github.com/ava-labs/libevm/core/types"
	"github.com/ava-labs/libevm/crypto"
	"github.com/ava-labs/libevm/rlp"
	"github.com/erigontech/mdbx-go/mdbx"
	"github.com/holiman/uint256"

	"block_fetcher/store"
)

// TrieUpdates holds the changes to trie nodes that need to be persisted.
type TrieUpdates struct {
	AccountNodes    map[string]*BranchNodeCompact            // packed nibble path -> node
	AccountRemovals map[string]bool                          // packed nibble path -> removed
	StorageNodes    map[string]map[string]*BranchNodeCompact // hex address -> (packed nibble path -> node)
	StorageRemovals map[string]map[string]bool               // hex address -> (packed nibble path -> removed)
}

// ChangedKeys represents which keys were modified in a block.
type ChangedKeys struct {
	Accounts  map[common.Address]bool                      // changed accounts
	Storage   map[common.Address]map[common.Hash]bool      // changed storage per account
	Destroyed map[common.Address]bool                      // destroyed accounts
}


// ComputeStateRoot computes the state root after applying changes.
// tx should be a read transaction with the NEW state already written.
// Returns the computed root hash and the trie node updates to persist.
//
// This is the "simple" implementation that reads ALL state from the DB,
// sorts it, and feeds it into the HashBuilder. It is O(total_state) rather
// than O(changed_state), suitable for early blocks where state is small.
func ComputeStateRoot(tx *mdbx.Txn, db *store.DB, changed *ChangedKeys) ([32]byte, *TrieUpdates, error) {
	updates := &TrieUpdates{
		AccountNodes:    make(map[string]*BranchNodeCompact),
		AccountRemovals: make(map[string]bool),
		StorageNodes:    make(map[string]map[string]*BranchNodeCompact),
		StorageRemovals: make(map[string]map[string]bool),
	}

	// Phase 1: Compute storage roots for all accounts that have storage.
	// We scan the entire StorageState table grouped by address.
	storageRoots, storageUpdates, err := computeAllStorageRoots(tx, db)
	if err != nil {
		return [32]byte{}, nil, err
	}
	for addr, nodeMap := range storageUpdates {
		updates.StorageNodes[addr] = nodeMap
	}

	// Phase 2: Compute account trie root.
	root, accountNodeUpdates, err := computeAccountRoot(tx, db, storageRoots)
	if err != nil {
		return [32]byte{}, nil, err
	}
	updates.AccountNodes = accountNodeUpdates

	return root, updates, nil
}

// hashedKV is a sorted (hashed_key, value) pair for feeding into the HashBuilder.
type hashedKV struct {
	hashedKey [32]byte
	value     []byte
}

// computeAllStorageRoots scans the entire StorageState table and computes
// per-account storage roots. Returns a map of raw address -> storage root hash,
// and a map of hex address -> branch node updates.
func computeAllStorageRoots(tx *mdbx.Txn, db *store.DB) (
	map[[20]byte][32]byte,
	map[string]map[string]*BranchNodeCompact,
	error,
) {
	roots := make(map[[20]byte][32]byte)
	allUpdates := make(map[string]map[string]*BranchNodeCompact)

	cursor, err := tx.OpenCursor(db.StorageState)
	if err != nil {
		return nil, nil, err
	}
	defer cursor.Close()

	// Collect all storage entries grouped by address.
	type addrSlots struct {
		addr  [20]byte
		pairs []hashedKV
	}
	var groups []addrSlots

	k, v, err := cursor.Get(nil, nil, mdbx.First)
	if err != nil {
		if mdbx.IsNotFound(err) {
			return roots, allUpdates, nil
		}
		return nil, nil, err
	}

	for {
		if len(k) < 52 {
			// Skip malformed keys.
			k, v, err = cursor.Get(nil, nil, mdbx.Next)
			if err != nil {
				if mdbx.IsNotFound(err) {
					break
				}
				return nil, nil, err
			}
			continue
		}

		var addr [20]byte
		var slot [32]byte
		copy(addr[:], k[:20])
		copy(slot[:], k[20:52])

		hashedSlot := crypto.Keccak256Hash(slot[:])

		// RLP-encode the storage value. geth's StateTrie.UpdateStorage
		// calls rlp.EncodeToBytes(value) before inserting into the trie.
		// Storage values in MDBX are already leading-zero-stripped.
		rlpVal, err := rlp.EncodeToBytes(v)
		if err != nil {
			return nil, nil, err
		}

		// Find or create the group for this address.
		if len(groups) == 0 || groups[len(groups)-1].addr != addr {
			groups = append(groups, addrSlots{addr: addr})
		}
		groups[len(groups)-1].pairs = append(groups[len(groups)-1].pairs, hashedKV{
			hashedKey: hashedSlot,
			value:     rlpVal,
		})

		k, v, err = cursor.Get(nil, nil, mdbx.Next)
		if err != nil {
			if mdbx.IsNotFound(err) {
				break
			}
			return nil, nil, err
		}
	}

	// Compute storage root for each account.
	for _, group := range groups {
		sort.Slice(group.pairs, func(i, j int) bool {
			return compareBytesLess(group.pairs[i].hashedKey[:], group.pairs[j].hashedKey[:])
		})

		hb := NewHashBuilder().WithUpdates()
		for _, pair := range group.pairs {
			nibbles := FromHex(pair.hashedKey[:])
			hb.AddLeaf(nibbles, pair.value)
		}
		root := hb.Root()
		roots[group.addr] = root

		if nodeMap := hb.Updates(); len(nodeMap) > 0 {
			addrHex := common.Bytes2Hex(group.addr[:])
			allUpdates[addrHex] = nodeMap
		}
	}

	return roots, allUpdates, nil
}

// computeAccountRoot scans the entire AccountState table and computes the
// account trie root. storageRoots provides per-account storage roots.
func computeAccountRoot(
	tx *mdbx.Txn,
	db *store.DB,
	storageRoots map[[20]byte][32]byte,
) ([32]byte, map[string]*BranchNodeCompact, error) {
	cursor, err := tx.OpenCursor(db.AccountState)
	if err != nil {
		return [32]byte{}, nil, err
	}
	defer cursor.Close()

	var pairs []hashedKV

	k, v, err := cursor.Get(nil, nil, mdbx.First)
	if err != nil {
		if mdbx.IsNotFound(err) {
			return EmptyRootHash, nil, nil
		}
		return [32]byte{}, nil, err
	}

	for {
		if len(k) < 20 {
			k, v, err = cursor.Get(nil, nil, mdbx.Next)
			if err != nil {
				if mdbx.IsNotFound(err) {
					break
				}
				return [32]byte{}, nil, err
			}
			continue
		}

		var addr [20]byte
		copy(addr[:], k[:20])
		acct := decodeStoreAccount(v)

		// Determine storage root.
		storageRoot := EmptyRootHash
		if sr, ok := storageRoots[addr]; ok {
			storageRoot = sr
		}

		// RLP-encode the account for the trie (full format matching geth).
		rlpVal, err := rlpEncodeAccount(acct, storageRoot)
		if err != nil {
			return [32]byte{}, nil, err
		}

		hashedAddr := crypto.Keccak256Hash(addr[:])
		pairs = append(pairs, hashedKV{
			hashedKey: hashedAddr,
			value:     rlpVal,
		})

		k, v, err = cursor.Get(nil, nil, mdbx.Next)
		if err != nil {
			if mdbx.IsNotFound(err) {
				break
			}
			return [32]byte{}, nil, err
		}
	}

	// Sort by hashed key.
	sort.Slice(pairs, func(i, j int) bool {
		return compareBytesLess(pairs[i].hashedKey[:], pairs[j].hashedKey[:])
	})

	hb := NewHashBuilder().WithUpdates()
	for _, pair := range pairs {
		nibbles := FromHex(pair.hashedKey[:])
		hb.AddLeaf(nibbles, pair.value)
	}
	root := hb.Root()

	return root, hb.Updates(), nil
}

// decodeStoreAccount decodes the flat-state account from its binary format
// (matching store.Account: 8-byte nonce + 32-byte balance + 32-byte codeHash).
func decodeStoreAccount(data []byte) *store.Account {
	acct := &store.Account{}
	if len(data) >= 8 {
		acct.Nonce = uint64(data[0])<<56 | uint64(data[1])<<48 |
			uint64(data[2])<<40 | uint64(data[3])<<32 |
			uint64(data[4])<<24 | uint64(data[5])<<16 |
			uint64(data[6])<<8 | uint64(data[7])
	}
	if len(data) >= 40 {
		copy(acct.Balance[:], data[8:40])
	}
	if len(data) >= 72 {
		copy(acct.CodeHash[:], data[40:72])
	}
	return acct
}

// emptyRootHash is the hash of an empty trie (keccak256(RLP(""))).
var emptyRootHash = common.HexToHash("56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421")

// emptyCodeHash is the keccak256 of empty bytes.
var emptyCodeHashSlice = common.FromHex("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")

// rlpEncodeAccount encodes an account for the state trie using full RLP encoding,
// matching what geth's trie.UpdateAccount does: rlp.EncodeToBytes(&StateAccount).
func rlpEncodeAccount(acct *store.Account, storageRoot [32]byte) ([]byte, error) {
	sa := types.StateAccount{
		Nonce:    acct.Nonce,
		Balance:  new(uint256.Int).SetBytes32(acct.Balance[:]),
		Root:     common.Hash(storageRoot),
		CodeHash: acct.CodeHash[:],
	}
	return rlp.EncodeToBytes(&sa)
}

// compareBytesLess returns true if a < b lexicographically.
func compareBytesLess(a, b []byte) bool {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] < b[i] {
			return true
		}
		if a[i] > b[i] {
			return false
		}
	}
	return len(a) < len(b)
}
