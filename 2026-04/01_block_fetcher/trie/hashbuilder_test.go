package trie

import (
	"bytes"
	"encoding/hex"
	"sort"
	"testing"

	"github.com/ava-labs/libevm/crypto"
)

// testKV is a key-value pair for testing.
type testKV struct {
	key Nibbles
	val []byte
}

func TestEmptyRoot(t *testing.T) {
	hb := NewHashBuilder()
	root := hb.Root()
	expected := EmptyRootHash
	if root != expected {
		t.Fatalf("empty root mismatch: got %x, want %x", root, expected)
	}

	expectedHex := "56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421"
	gotHex := hex.EncodeToString(root[:])
	if gotHex != expectedHex {
		t.Fatalf("empty root hex mismatch: got %s, want %s", gotHex, expectedHex)
	}
}

func TestCompactEncode(t *testing.T) {
	tests := []struct {
		nibbles  []byte
		isLeaf   bool
		expected string
	}{
		{[]byte{0x0A, 0x0B, 0x0C, 0x0D}, false, "00abcd"},
		{[]byte{0x0A, 0x0B, 0x0C}, false, "1abc"},
		{[]byte{0x0A, 0x0B, 0x0C, 0x0D}, true, "20abcd"},
		{[]byte{0x0A, 0x0B, 0x0C}, true, "3abc"},
	}

	for _, tt := range tests {
		n := nibFromSlice(tt.nibbles)
		got := compactEncode(n, tt.isLeaf)
		gotHex := hex.EncodeToString(got)
		if gotHex != tt.expected {
			t.Errorf("compactEncode(%v, leaf=%v) = %s, want %s",
				tt.nibbles, tt.isLeaf, gotHex, tt.expected)
		}
	}
}

func TestCompactEncodeEmpty(t *testing.T) {
	result := compactEncode(Nibbles{}, true)
	if !bytes.Equal(result, []byte{0x20}) {
		t.Fatalf("empty leaf compact: got %x, want 20", result)
	}
	result = compactEncode(Nibbles{}, false)
	if !bytes.Equal(result, []byte{0x00}) {
		t.Fatalf("empty extension compact: got %x, want 00", result)
	}
}

func nibFromSlice(nibbles []byte) Nibbles {
	n := Nibbles{}
	for _, nib := range nibbles {
		n = n.Append(nib)
	}
	return n
}

func TestSingleLeaf(t *testing.T) {
	hb := NewHashBuilder()

	key := make([]byte, 32)
	key[31] = 1
	nibbles := FromHex(key)
	value := rlpEncodeU256(2)

	hb.AddLeaf(nibbles, value)
	root := hb.Root()

	leafRLP := rlpEncodeLeafNode(nibbles, value)
	expected := crypto.Keccak256Hash(leafRLP)
	if root != expected {
		t.Fatalf("single leaf root mismatch: got %x, want %x", root, expected)
	}
}

func TestTwoLeaves(t *testing.T) {
	key1, _ := hex.DecodeString("0000000000000000000000000000000000000000000000000000000000000001")
	key2, _ := hex.DecodeString("0000000000000000000000000000000000000000000000000000000000000002")

	pairs := []testKV{
		{FromHex(key1), rlpEncodeU256(100)},
		{FromHex(key2), rlpEncodeU256(200)},
	}
	sort.Slice(pairs, func(i, j int) bool {
		return pairs[i].key.Compare(pairs[j].key) < 0
	})

	hb := NewHashBuilder()
	for _, p := range pairs {
		hb.AddLeaf(p.key, p.val)
	}
	root := hb.Root()

	refRoot := naiveTrieRoot(pairs)
	if root != refRoot {
		t.Fatalf("two leaves root mismatch:\ngot  %x\nwant %x", root, refRoot)
	}
}

func TestRawDataTrieRoot(t *testing.T) {
	data := [][2]string{
		{"646f", "76657262"},
		{"676f6f64", "7075707079"},
		{"676f6b32", "7075707079"},
		{"676f6b34", "7075707079"},
	}

	var pairs []testKV
	for _, d := range data {
		keyBytes, _ := hex.DecodeString(d[0])
		valBytes, _ := hex.DecodeString(d[1])
		pairs = append(pairs, testKV{FromHex(keyBytes), valBytes})
	}
	sort.Slice(pairs, func(i, j int) bool {
		return pairs[i].key.Compare(pairs[j].key) < 0
	})

	hb := NewHashBuilder()
	for _, p := range pairs {
		hb.AddLeaf(p.key, p.val)
	}
	root := hb.Root()

	refRoot := naiveTrieRoot(pairs)
	if root != refRoot {
		t.Fatalf("raw data root mismatch:\ngot  %x\nwant %x", root, refRoot)
	}
}

func TestHashedDataTrieRoot(t *testing.T) {
	var pairs []testKV

	k1 := make([]byte, 32)
	k1[31] = 1
	h1 := crypto.Keccak256(k1)
	pairs = append(pairs, testKV{FromHex(h1), rlpEncodeU256(2)})

	k2 := make([]byte, 32)
	k2[31] = 3
	h2 := crypto.Keccak256(k2)
	pairs = append(pairs, testKV{FromHex(h2), rlpEncodeU256(4)})

	sort.Slice(pairs, func(i, j int) bool {
		return pairs[i].key.Compare(pairs[j].key) < 0
	})

	hb := NewHashBuilder()
	for _, p := range pairs {
		hb.AddLeaf(p.key, p.val)
	}
	root := hb.Root()

	refRoot := naiveTrieRoot(pairs)
	if root != refRoot {
		t.Fatalf("hashed data root mismatch:\ngot  %x\nwant %x", root, refRoot)
	}
}

func TestKnownHash(t *testing.T) {
	hashHex := "45596e474b536a6b4d64764e4f75514d544577646c414e684271706871446456"
	var rootHash [32]byte
	b, _ := hex.DecodeString(hashHex)
	copy(rootHash[:], b)

	hb := NewHashBuilder()
	hb.AddBranch(Nibbles{}, rootHash, false)
	got := hb.Root()
	if got != rootHash {
		t.Fatalf("known hash mismatch: got %x, want %x", got, rootHash)
	}
}

func TestManyLeaves(t *testing.T) {
	var pairs []testKV
	for i := 0; i < 100; i++ {
		keyPreimage := make([]byte, 32)
		keyPreimage[31] = byte(i)
		keyPreimage[30] = byte(i >> 8)
		h := crypto.Keccak256(keyPreimage)
		v := rlpEncodeU256(uint64(i * 100))
		pairs = append(pairs, testKV{FromHex(h), v})
	}

	sort.Slice(pairs, func(i, j int) bool {
		return pairs[i].key.Compare(pairs[j].key) < 0
	})

	hb := NewHashBuilder()
	for _, p := range pairs {
		hb.AddLeaf(p.key, p.val)
	}
	root := hb.Root()

	refRoot := naiveTrieRoot(pairs)
	if root != refRoot {
		t.Fatalf("many leaves root mismatch:\ngot  %x\nwant %x", root, refRoot)
	}
}

func TestBranchNodeGeneration(t *testing.T) {
	hb := NewHashBuilder().WithUpdates()

	data := [][2]string{
		{"1000000000000000000000000000000000000000000000000000000000000000", ""},
		{"1100000000000000000000000000000000000000000000000000000000000000", ""},
		{"1110000000000000000000000000000000000000000000000000000000000000", ""},
		{"1200000000000000000000000000000000000000000000000000000000000000", ""},
		{"1220000000000000000000000000000000000000000000000000000000000000", ""},
		{"1320000000000000000000000000000000000000000000000000000000000000", ""},
	}

	var pairs []testKV
	for _, d := range data {
		keyBytes, _ := hex.DecodeString(d[0])
		valBytes, _ := hex.DecodeString(d[1])
		pairs = append(pairs, testKV{FromHex(keyBytes), valBytes})
	}

	for _, p := range pairs {
		hb.AddLeaf(p.key, p.val)
	}
	root := hb.Root()

	refRoot := naiveTrieRoot(pairs)
	if root != refRoot {
		t.Fatalf("branch generation root mismatch:\ngot  %x\nwant %x", root, refRoot)
	}
}

// --- Helpers ---

func rlpEncodeU256(v uint64) []byte {
	if v == 0 {
		return []byte{0x80}
	}
	b := encodeUint(v)
	return rlpEncodeString(b)
}

// --- Naive in-memory trie for reference ---

type naiveTrieNode struct {
	children [16]*naiveTrieNode
	value    []byte
}

func (n *naiveTrieNode) insert(key Nibbles, offset int, value []byte) {
	if offset == key.Len() {
		n.value = value
		return
	}
	nib := key.At(offset)
	if n.children[nib] == nil {
		n.children[nib] = &naiveTrieNode{}
	}
	n.children[nib].insert(key, offset+1, value)
}

func (n *naiveTrieNode) encodeBranch() []byte {
	var payload []byte
	for i := 0; i < 16; i++ {
		if n.children[i] != nil {
			childRLP := n.children[i].encodeNode()
			childRef := rlpNodeFromRLP(childRLP)
			payload = append(payload, childRef...)
		} else {
			payload = append(payload, 0x80)
		}
	}
	if n.value != nil {
		payload = append(payload, rlpEncodeString(n.value)...)
	} else {
		payload = append(payload, 0x80)
	}
	return rlpEncodeList(payload)
}

func (n *naiveTrieNode) encodeNode() []byte {
	var activeChildren []int
	for i := 0; i < 16; i++ {
		if n.children[i] != nil {
			activeChildren = append(activeChildren, i)
		}
	}

	if len(activeChildren) == 0 && n.value != nil {
		return rlpEncodeLeafNode(Nibbles{}, n.value)
	}

	if len(activeChildren) == 1 && n.value == nil {
		path := []byte{byte(activeChildren[0])}
		child := n.children[activeChildren[0]]
		for {
			var nextActive []int
			for i := 0; i < 16; i++ {
				if child.children[i] != nil {
					nextActive = append(nextActive, i)
				}
			}
			if len(nextActive) == 1 && child.value == nil {
				path = append(path, byte(nextActive[0]))
				child = child.children[nextActive[0]]
			} else if len(nextActive) == 0 && child.value != nil {
				pathNibbles := nibFromSlice(path)
				return rlpEncodeLeafNode(pathNibbles, child.value)
			} else {
				break
			}
		}

		childRLP := child.encodeBranch()
		childRef := rlpNodeFromRLP(childRLP)
		pathNibbles := nibFromSlice(path)
		return rlpEncodeExtensionNode(pathNibbles, childRef)
	}

	return n.encodeBranch()
}

func naiveTrieRoot(pairs []testKV) [32]byte {
	if len(pairs) == 0 {
		return EmptyRootHash
	}

	root := &naiveTrieNode{}
	for _, p := range pairs {
		root.insert(p.key, 0, p.val)
	}

	rlpData := root.encodeNode()
	return crypto.Keccak256Hash(rlpData)
}
