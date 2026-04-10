package trie

import (
	"encoding/hex"
	"fmt"
	"sort"
	"testing"

	cparams "github.com/ava-labs/avalanchego/graft/coreth/params"
	ccustomtypes "github.com/ava-labs/avalanchego/graft/coreth/plugin/evm/customtypes"
	"github.com/ava-labs/libevm/common"
	"github.com/ava-labs/libevm/core/rawdb"
	"github.com/ava-labs/libevm/core/types"
	"github.com/ava-labs/libevm/crypto"
	"github.com/ava-labs/libevm/rlp"
	libtrie "github.com/ava-labs/libevm/trie"
	"github.com/ava-labs/libevm/triedb"
	"github.com/holiman/uint256"

	"block_fetcher/store"
)

var registeredExtras bool

func init() {
	cparams.RegisterExtras()
	ccustomtypes.Register()
	registeredExtras = true
}

// TestBlock19NoExtra tests if the expected root matches when Extra is NOT in the encoding.
func TestBlock19NoExtra(t *testing.T) {
	// Manually encode accounts WITHOUT the Extra field to simulate pre-Extra behavior.
	// Standard geth encoding: [nonce, balance, root, codeHash]
	type plainStateAccount struct {
		Nonce    uint64
		Balance  *uint256.Int
		Root     common.Hash
		CodeHash []byte
	}

	hexToBytes32 := func(s string) [32]byte {
		b, _ := hex.DecodeString(s)
		var out [32]byte
		copy(out[:], b)
		return out
	}
	hexToAddr := func(s string) [20]byte {
		b, _ := hex.DecodeString(s)
		var out [20]byte
		copy(out[:], b)
		return out
	}

	type acctInfo struct {
		addr     [20]byte
		nonce    uint64
		balance  [32]byte
		codeHash [32]byte
	}

	accounts := []acctInfo{
		{hexToAddr("0100000000000000000000000000000000000000"), 0,
			hexToBytes32("000000000000000000000000000000000000000000000000232a8d01fb4df800"),
			hexToBytes32("611445c10cb8404ad2103d510e139c3ace61b5acec80505bd1f5870528f587d7")},
		{hexToAddr("010da5ff62b6e45f89fa7b2d8ced5a8b5754ec1b"), 0,
			hexToBytes32("00000000000000000000000000000000000000000000000107ad8f556c6c0000"),
			store.EmptyCodeHash},
		{hexToAddr("02dc93ccd8b4c1150ab0e50168eab3e4df817d33"), 1,
			hexToBytes32("0000000000000000000000000000000000000000000000000229d725ec58d800"),
			store.EmptyCodeHash},
		{hexToAddr("0c498d075ae2236cfd13800abc61caf04b8fad63"), 0,
			hexToBytes32("000000000000000000000000000000000000000000000000002aa1efb94e0000"),
			store.EmptyCodeHash},
		{hexToAddr("436e85c85600a9060456610f679543eaafe59f1f"), 1,
			hexToBytes32("0000000000000000000000000000000000000000000000000000000000000000"),
			hexToBytes32("318e313444a3e35b96c06b6f58c6877347c41c24456674a67142cb6b83d4ea1d")},
		{hexToAddr("5dc6edda392e72d366b3c2b1f6016f84238fe103"), 0,
			hexToBytes32("00000000000000000000000000000000000000000000000006f05b59d3b20000"),
			store.EmptyCodeHash},
		{hexToAddr("640440c1a691dc824c89f92a856848a9013d3784"), 1,
			hexToBytes32("0000000000000000000000000000000000000000000000000000000000000000"),
			hexToBytes32("40ad37ad80ff48f853420017fd7a68062b380e0068fbeb643ad3fa64dd955695")},
		{hexToAddr("641413368bf29f475bb6ff9981edaee570a2b87a"), 1,
			hexToBytes32("0000000000000000000000000000000000000000000000000000000000000000"),
			hexToBytes32("40ad37ad80ff48f853420017fd7a68062b380e0068fbeb643ad3fa64dd955695")},
		{hexToAddr("967d458697fb512394740a37d39c3a1ca90b1a30"), 6,
			hexToBytes32("0000000000000000000000000000000000000000000000003c2b20ae78f5b000"),
			store.EmptyCodeHash},
		{hexToAddr("b8b5a87d1c05676f1f966da49151fa54dbe68c33"), 0,
			hexToBytes32("0000000000000000000000000000000000000000000000000214e8348c4f0000"),
			store.EmptyCodeHash},
		{hexToAddr("fa76df8588c1033b671d1861e0e5bde3c26040c7"), 4,
			hexToBytes32("00000000000000000000000000000000000000000000000005b275c3d5318000"),
			store.EmptyCodeHash},
	}

	// Storage root for contract
	storageRoot := common.HexToHash("306f716111ac5d0feb0b71f16c00e178cac886592018b2e63aa191f75ddcf9dc")
	contractAddr := hexToAddr("436e85c85600a9060456610f679543eaafe59f1f")

	// Encode accounts WITHOUT Extra field
	var pairs []hashedKV
	for _, a := range accounts {
		sr := EmptyRootHash
		if a.addr == contractAddr {
			sr = [32]byte(storageRoot)
		}
		// Use plain struct WITHOUT Extra field
		sa := plainStateAccount{
			Nonce:    a.nonce,
			Balance:  new(uint256.Int).SetBytes32(a.balance[:]),
			Root:     common.Hash(sr),
			CodeHash: a.codeHash[:],
		}
		encoded, err := rlp.EncodeToBytes(&sa)
		if err != nil {
			t.Fatal(err)
		}
		hashedAddr := crypto.Keccak256Hash(a.addr[:])
		pairs = append(pairs, hashedKV{hashedKey: hashedAddr, value: encoded})
	}
	sort.Slice(pairs, func(i, j int) bool {
		return compareBytesLess(pairs[i].hashedKey[:], pairs[j].hashedKey[:])
	})

	hb := NewHashBuilder()
	for _, pair := range pairs {
		nibbles := FromHex(pair.hashedKey[:])
		hb.AddLeaf(nibbles, pair.value)
	}
	root := hb.Root()
	expected := common.HexToHash("9b08698772fa7a66a45aa6f80b4fc660cea93af41be9c87615a2bdf657db0002")
	t.Logf("no-Extra root: %x", root)
	t.Logf("expected:      %x", expected)
	if common.Hash(root) == expected {
		t.Log("MATCH! The issue is the libevm Extra field in account encoding.")
	} else {
		t.Error("Still doesn't match")
	}
}

// TestBlock19StorageTrie computes the storage trie root for the contract
// created in block 19 using both our HashBuilder and geth's trie.
func TestBlock19StorageTrie(t *testing.T) {
	type slot struct {
		key [32]byte
		val []byte // trimmed value
	}

	hexToBytes32 := func(s string) [32]byte {
		b, _ := hex.DecodeString(s)
		var out [32]byte
		copy(out[:], b)
		return out
	}
	hexToBytes := func(s string) []byte {
		b, _ := hex.DecodeString(s)
		// Trim leading zeros like store.PutStorage does
		for len(b) > 1 && b[0] == 0 {
			b = b[1:]
		}
		return b
	}

	slots := []slot{
		{hexToBytes32("0000000000000000000000000000000000000000000000000000000000000006"),
			hexToBytes("4e5458436572746966696361746500000000000000000000000000000000001c")},
		{hexToBytes32("0000000000000000000000000000000000000000000000000000000000000007"),
			hexToBytes("4e54584300000000000000000000000000000000000000000000000000000008")},
		{hexToBytes32("67be87c3ff9960ca1e9cfac5cab2ff4747269cf9ed20c9b7306235ac35a491c5"),
			hexToBytes("01")},
		{hexToBytes32("77b7bbe0e49b76487c9476b5db3354cf5270619d0037ccb899c2a4c4a75b4318"),
			hexToBytes("01")},
		{hexToBytes32("9562381dfbc2d8b8b66e765249f330164b73e329e5f01670660643571d1974df"),
			hexToBytes("01")},
		{hexToBytes32("f7815fccbf112960a73756e185887fedcb9fc64ca0a16cc5923b7960ed780800"),
			hexToBytes("01")},
	}

	// === Compute using geth's trie ===
	memdb := rawdb.NewMemoryDatabase()
	trieDB := triedb.NewDatabase(memdb, nil)
	gethTrie := libtrie.NewEmpty(trieDB)

	for _, s := range slots {
		hashedKey := crypto.Keccak256(s.key[:])
		gethTrie.Update(hashedKey, s.val)
	}
	gethRoot := gethTrie.Hash()
	t.Logf("geth storage root: %x", gethRoot)

	// === Compute using our HashBuilder ===
	var pairs []hashedKV
	for _, s := range slots {
		hashedSlot := crypto.Keccak256Hash(s.key[:])
		pairs = append(pairs, hashedKV{
			hashedKey: hashedSlot,
			value:     s.val,
		})
	}
	sort.Slice(pairs, func(i, j int) bool {
		return compareBytesLess(pairs[i].hashedKey[:], pairs[j].hashedKey[:])
	})

	hb := NewHashBuilder()
	for _, pair := range pairs {
		nibbles := FromHex(pair.hashedKey[:])
		hb.AddLeaf(nibbles, pair.value)
	}
	ourRoot := hb.Root()
	t.Logf("our  storage root: %x", ourRoot)

	if gethRoot != common.Hash(ourRoot) {
		t.Errorf("storage root MISMATCH: geth=%x ours=%x", gethRoot, ourRoot)

		// Debug: print each entry's hashed key
		for _, pair := range pairs {
			t.Logf("  hashed=%x val=%x", pair.hashedKey, pair.value)
		}
	} else {
		t.Logf("storage roots MATCH!")
	}

	// === Now compute the full account trie for block 19 state ===
	type acctInfo struct {
		addr     [20]byte
		nonce    uint64
		balance  [32]byte
		codeHash [32]byte
		hasCode  bool
	}

	hexToAddr := func(s string) [20]byte {
		b, _ := hex.DecodeString(s)
		var out [20]byte
		copy(out[:], b)
		return out
	}

	accounts := []acctInfo{
		{hexToAddr("0100000000000000000000000000000000000000"), 0,
			hexToBytes32("000000000000000000000000000000000000000000000000232a8d01fb4df800"),
			hexToBytes32("611445c10cb8404ad2103d510e139c3ace61b5acec80505bd1f5870528f587d7"), true},
		{hexToAddr("010da5ff62b6e45f89fa7b2d8ced5a8b5754ec1b"), 0,
			hexToBytes32("00000000000000000000000000000000000000000000000107ad8f556c6c0000"),
			store.EmptyCodeHash, false},
		{hexToAddr("02dc93ccd8b4c1150ab0e50168eab3e4df817d33"), 1,
			hexToBytes32("0000000000000000000000000000000000000000000000000229d725ec58d800"),
			store.EmptyCodeHash, false},
		{hexToAddr("0c498d075ae2236cfd13800abc61caf04b8fad63"), 0,
			hexToBytes32("000000000000000000000000000000000000000000000000002aa1efb94e0000"),
			store.EmptyCodeHash, false},
		{hexToAddr("436e85c85600a9060456610f679543eaafe59f1f"), 1,
			hexToBytes32("0000000000000000000000000000000000000000000000000000000000000000"),
			hexToBytes32("318e313444a3e35b96c06b6f58c6877347c41c24456674a67142cb6b83d4ea1d"), true},
		{hexToAddr("5dc6edda392e72d366b3c2b1f6016f84238fe103"), 0,
			hexToBytes32("00000000000000000000000000000000000000000000000006f05b59d3b20000"),
			store.EmptyCodeHash, false},
		{hexToAddr("640440c1a691dc824c89f92a856848a9013d3784"), 1,
			hexToBytes32("0000000000000000000000000000000000000000000000000000000000000000"),
			hexToBytes32("40ad37ad80ff48f853420017fd7a68062b380e0068fbeb643ad3fa64dd955695"), true},
		{hexToAddr("641413368bf29f475bb6ff9981edaee570a2b87a"), 1,
			hexToBytes32("0000000000000000000000000000000000000000000000000000000000000000"),
			hexToBytes32("40ad37ad80ff48f853420017fd7a68062b380e0068fbeb643ad3fa64dd955695"), true},
		{hexToAddr("967d458697fb512394740a37d39c3a1ca90b1a30"), 6,
			hexToBytes32("0000000000000000000000000000000000000000000000003c2b20ae78f5b000"),
			store.EmptyCodeHash, false},
		{hexToAddr("b8b5a87d1c05676f1f966da49151fa54dbe68c33"), 0,
			hexToBytes32("0000000000000000000000000000000000000000000000000214e8348c4f0000"),
			store.EmptyCodeHash, false},
		{hexToAddr("fa76df8588c1033b671d1861e0e5bde3c26040c7"), 4,
			hexToBytes32("00000000000000000000000000000000000000000000000005b275c3d5318000"),
			store.EmptyCodeHash, false},
	}

	// Storage roots per account (only the contract has storage)
	contractAddr := hexToAddr("436e85c85600a9060456610f679543eaafe59f1f")
	storageRoots := map[[20]byte][32]byte{
		contractAddr: [32]byte(gethRoot), // use geth's correct root
	}

	// Compute geth account trie
	gethAcctTrie := libtrie.NewEmpty(trieDB)
	for _, a := range accounts {
		storageRoot := EmptyRootHash
		if sr, ok := storageRoots[a.addr]; ok {
			storageRoot = sr
		}
		sa := types.StateAccount{
			Nonce:    a.nonce,
			Balance:  new(uint256.Int).SetBytes32(a.balance[:]),
			Root:     common.Hash(storageRoot),
			CodeHash: a.codeHash[:],
		}
		encoded, _ := rlp.EncodeToBytes(&sa)
		hashedAddr := crypto.Keccak256(a.addr[:])
		gethAcctTrie.Update(hashedAddr, encoded)
	}
	gethAcctRoot := gethAcctTrie.Hash()
	t.Logf("geth account root: %x", gethAcctRoot)

	// Compute our account trie
	var acctPairs []hashedKV
	for _, a := range accounts {
		storageRoot := EmptyRootHash
		if sr, ok := storageRoots[a.addr]; ok {
			storageRoot = sr
		}
		acct := &store.Account{
			Nonce:    a.nonce,
			Balance:  a.balance,
			CodeHash: a.codeHash,
		}
		rlpVal, _ := rlpEncodeAccount(acct, storageRoot)
		hashedAddr := crypto.Keccak256Hash(a.addr[:])
		acctPairs = append(acctPairs, hashedKV{
			hashedKey: hashedAddr,
			value:     rlpVal,
		})
	}
	sort.Slice(acctPairs, func(i, j int) bool {
		return compareBytesLess(acctPairs[i].hashedKey[:], acctPairs[j].hashedKey[:])
	})

	hb2 := NewHashBuilder()
	for _, pair := range acctPairs {
		nibbles := FromHex(pair.hashedKey[:])
		hb2.AddLeaf(nibbles, pair.value)
	}
	ourAcctRoot := hb2.Root()
	t.Logf("our  account root: %x", ourAcctRoot)

	expectedRoot := common.HexToHash("9b08698772fa7a66a45aa6f80b4fc660cea93af41be9c87615a2bdf657db0002")
	t.Logf("expected root:     %x", expectedRoot)

	if gethAcctRoot != expectedRoot {
		t.Errorf("geth root doesn't match expected! geth=%x expected=%x", gethAcctRoot, expectedRoot)
		// Compare individual account encodings
		for _, a := range accounts {
			storageRoot := EmptyRootHash
			if sr, ok := storageRoots[a.addr]; ok {
				storageRoot = sr
			}
			sa := types.StateAccount{
				Nonce:    a.nonce,
				Balance:  new(uint256.Int).SetBytes32(a.balance[:]),
				Root:     common.Hash(storageRoot),
				CodeHash: a.codeHash[:],
			}
			encoded, _ := rlp.EncodeToBytes(&sa)
			t.Logf("  acct %x: nonce=%d balance=%x storageRoot=%x rlp=%x",
				a.addr, a.nonce, a.balance, storageRoot, encoded)
		}
	}

	if common.Hash(ourAcctRoot) != gethAcctRoot {
		t.Errorf("our root doesn't match geth! ours=%x geth=%x", ourAcctRoot, gethAcctRoot)

		// Print sorted entries for debugging
		for _, pair := range acctPairs {
			t.Logf("  key=%x val=%x", pair.hashedKey, pair.value)
		}
	}

	fmt.Printf("Summary: geth=%x ours=%x expected=%x\n", gethAcctRoot, ourAcctRoot, expectedRoot)
}

// TestBlock18Root computes the state root at block 18 to verify our encoding.
func TestBlock18Root(t *testing.T) {
	type plainStateAccount struct {
		Nonce    uint64
		Balance  *uint256.Int
		Root     common.Hash
		CodeHash []byte
	}

	hexToBytes32 := func(s string) [32]byte {
		b, _ := hex.DecodeString(s)
		var out [32]byte
		copy(out[:], b)
		return out
	}
	hexToAddr := func(s string) [20]byte {
		b, _ := hex.DecodeString(s)
		var out [20]byte
		copy(out[:], b)
		return out
	}

	// Accounts at block 18 (from RPC query above)
	type acctInfo struct {
		addr     [20]byte
		nonce    uint64
		balance  string // hex
		codeHash [32]byte
	}

	accounts := []acctInfo{
		{hexToAddr("0100000000000000000000000000000000000000"), 0, "1773ad744042d000",
			hexToBytes32("611445c10cb8404ad2103d510e139c3ace61b5acec80505bd1f5870528f587d7")},
		{hexToAddr("010da5ff62b6e45f89fa7b2d8ced5a8b5754ec1b"), 0, "0107ad8f556c6c0000",
			store.EmptyCodeHash},
		{hexToAddr("02dc93ccd8b4c1150ab0e50168eab3e4df817d33"), 0, "0de0b6b3a7640000",
			store.EmptyCodeHash},
		{hexToAddr("0c498d075ae2236cfd13800abc61caf04b8fad63"), 0, "2aa1efb94e0000",
			store.EmptyCodeHash},
		{hexToAddr("5dc6edda392e72d366b3c2b1f6016f84238fe103"), 0, "06f05b59d3b20000",
			store.EmptyCodeHash},
		{hexToAddr("640440c1a691dc824c89f92a856848a9013d3784"), 1, "00",
			hexToBytes32("40ad37ad80ff48f853420017fd7a68062b380e0068fbeb643ad3fa64dd955695")},
		{hexToAddr("641413368bf29f475bb6ff9981edaee570a2b87a"), 1, "00",
			hexToBytes32("40ad37ad80ff48f853420017fd7a68062b380e0068fbeb643ad3fa64dd955695")},
		{hexToAddr("967d458697fb512394740a37d39c3a1ca90b1a30"), 6, "3c2b20ae78f5b000",
			store.EmptyCodeHash},
		{hexToAddr("b8b5a87d1c05676f1f966da49151fa54dbe68c33"), 0, "0214e8348c4f0000",
			store.EmptyCodeHash},
		{hexToAddr("fa76df8588c1033b671d1861e0e5bde3c26040c7"), 4, "05b275c3d5318000",
			store.EmptyCodeHash},
	}

	// No storage at block 18

	// With Extra field (coreth registered)
	var pairsWithExtra []hashedKV
	for _, a := range accounts {
		bal, _ := uint256.FromHex("0x" + a.balance)
		sa := types.StateAccount{
			Nonce:    a.nonce,
			Balance:  bal,
			Root:     common.Hash(EmptyRootHash),
			CodeHash: a.codeHash[:],
		}
		encoded, _ := rlp.EncodeToBytes(&sa)
		hashedAddr := crypto.Keccak256Hash(a.addr[:])
		pairsWithExtra = append(pairsWithExtra, hashedKV{hashedKey: hashedAddr, value: encoded})
	}
	sort.Slice(pairsWithExtra, func(i, j int) bool {
		return compareBytesLess(pairsWithExtra[i].hashedKey[:], pairsWithExtra[j].hashedKey[:])
	})

	hb := NewHashBuilder()
	for _, pair := range pairsWithExtra {
		nibbles := FromHex(pair.hashedKey[:])
		hb.AddLeaf(nibbles, pair.value)
	}
	rootWithExtra := hb.Root()

	// Without Extra field
	var pairsNoExtra []hashedKV
	for _, a := range accounts {
		bal, _ := uint256.FromHex("0x" + a.balance)
		sa := plainStateAccount{
			Nonce:    a.nonce,
			Balance:  bal,
			Root:     common.Hash(EmptyRootHash),
			CodeHash: a.codeHash[:],
		}
		encoded, _ := rlp.EncodeToBytes(&sa)
		hashedAddr := crypto.Keccak256Hash(a.addr[:])
		pairsNoExtra = append(pairsNoExtra, hashedKV{hashedKey: hashedAddr, value: encoded})
	}
	sort.Slice(pairsNoExtra, func(i, j int) bool {
		return compareBytesLess(pairsNoExtra[i].hashedKey[:], pairsNoExtra[j].hashedKey[:])
	})

	hb2 := NewHashBuilder()
	for _, pair := range pairsNoExtra {
		nibbles := FromHex(pair.hashedKey[:])
		hb2.AddLeaf(nibbles, pair.value)
	}
	rootNoExtra := hb2.Root()

	expected := common.HexToHash("c019c20359712da455c0f5434ce1a51401f389b5c4442433809b7dc5799db988")
	t.Logf("with Extra:    %x", rootWithExtra)
	t.Logf("without Extra: %x", rootNoExtra)
	t.Logf("expected:      %x", expected)

	if common.Hash(rootWithExtra) == expected {
		t.Log("With Extra MATCHES block 18!")
	}
	if common.Hash(rootNoExtra) == expected {
		t.Log("Without Extra MATCHES block 18!")
	}
	if common.Hash(rootWithExtra) != expected && common.Hash(rootNoExtra) != expected {
		t.Error("Neither matches block 18 expected root")
	}
}
