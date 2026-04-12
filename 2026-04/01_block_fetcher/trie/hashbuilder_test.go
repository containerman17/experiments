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

func bytesToNibbles(b []byte) []byte {
	out := make([]byte, 0, len(b)*2)
	for _, v := range b {
		out = append(out, v>>4, v&0x0f)
	}
	return out
}

func rootFromRelativeLeaves(leaves []testKV) [32]byte {
	sort.Slice(leaves, func(i, j int) bool {
		return leaves[i].key.Compare(leaves[j].key) < 0
	})
	hb := NewHashBuilder()
	for _, leaf := range leaves {
		hb.AddLeaf(leaf.key, leaf.val)
	}
	return hb.Root()
}

func refFromRelativeLeaves(leaves []testKV) []byte {
	sort.Slice(leaves, func(i, j int) bool {
		return leaves[i].key.Compare(leaves[j].key) < 0
	})
	hb := NewHashBuilder()
	for _, leaf := range leaves {
		hb.AddLeaf(leaf.key, leaf.val)
	}
	hb.Root()
	if len(hb.stack) == 0 {
		return nil
	}
	ref := make([]byte, len(hb.stack[len(hb.stack)-1].ref))
	copy(ref, hb.stack[len(hb.stack)-1].ref)
	return ref
}

func nibsFromString(t *testing.T, s string) Nibbles {
	t.Helper()
	nibs := make([]byte, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= '0' && c <= '9':
			nibs[i] = c - '0'
		case c >= 'a' && c <= 'f':
			nibs[i] = c - 'a' + 10
		default:
			t.Fatalf("invalid nibble string %q", s)
		}
	}
	return nibFromSlice(nibs)
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

func TestSingleCachedBranchMatchesAllLeaves(t *testing.T) {
	makeKey := func(hexKey string) Nibbles { return nibsFromString(t, hexKey) }

	leaves := []testKV{
		{makeKey("710"), []byte{0x01}},
		{makeKey("7f0"), []byte{0x02}},
	}

	full20 := rootFromRelativeLeaves(leaves)

	var under207 []testKV
	for _, leaf := range leaves {
		under207 = append(under207, testKV{
			key: leaf.key.Slice(1, leaf.key.Len()),
			val: leaf.val,
		})
	}
	ref207 := refFromRelativeLeaves(under207)
	explicit20 := crypto.Keccak256Hash(rlpEncodeExtensionNode(nibFromSlice([]byte{0x7}), ref207))

	hb := NewHashBuilder()
	hb.AddBranchRef(nibFromSlice([]byte{0x7}), ref207, false)
	mixed20 := hb.Root()

	if explicit20 != full20 {
		t.Fatalf("explicit extension mismatch:\ngot  %x\nwant %x\nref=%x", explicit20, full20, ref207)
	}
	if mixed20 != full20 {
		t.Fatalf("single cached branch mismatch:\ngot  %x\nwant %x\nexplicit %x\nref=%x", mixed20, full20, explicit20, ref207)
	}
}

func TestCachedBranchesAndLeavesMatchAllLeaves(t *testing.T) {
	makeKey := func(hexKey string) Nibbles { return nibsFromString(t, hexKey) }

	leaves := []testKV{
		{makeKey("210"), []byte{0x01}},
		{makeKey("2f0"), []byte{0x02}},
		{makeKey("510"), []byte{0x03}},
		{makeKey("5f0"), []byte{0x04}},
		{makeKey("ac0"), []byte{0x05}},
	}

	full0b := rootFromRelativeLeaves(leaves)

	ref0b2 := refFromRelativeLeaves([]testKV{
		{key: makeKey("10"), val: []byte{0x01}},
		{key: makeKey("f0"), val: []byte{0x02}},
	})
	ref0b5 := refFromRelativeLeaves([]testKV{
		{key: makeKey("10"), val: []byte{0x03}},
		{key: makeKey("f0"), val: []byte{0x04}},
	})

	hb := NewHashBuilder()
	hb.AddBranchRef(nibFromSlice([]byte{0x2}), ref0b2, false)
	hb.AddBranchRef(nibFromSlice([]byte{0x5}), ref0b5, false)
	hb.AddLeaf(makeKey("ac0"), []byte{0x05})
	mixed0b := hb.Root()

	if mixed0b != full0b {
		t.Fatalf("cached branches + leaf mismatch:\ngot  %x\nwant %x", mixed0b, full0b)
	}
}

func TestSingleCachedHashedBranchMatchesAllLeaves(t *testing.T) {
	makeKey := func(hexKey string) Nibbles { return nibsFromString(t, hexKey) }

	// Enough leaves under prefix 7 to force the cached child reference to be rlp(hash).
	leaves := []testKV{
		{makeKey("710"), []byte{0x01}},
		{makeKey("720"), []byte{0x02}},
		{makeKey("730"), []byte{0x03}},
		{makeKey("740"), []byte{0x04}},
		{makeKey("750"), []byte{0x05}},
		{makeKey("760"), []byte{0x06}},
		{makeKey("770"), []byte{0x07}},
		{makeKey("780"), []byte{0x08}},
		{makeKey("790"), []byte{0x09}},
	}

	full20 := rootFromRelativeLeaves(leaves)

	var under7 []testKV
	for _, leaf := range leaves {
		under7 = append(under7, testKV{
			key: leaf.key.Slice(1, leaf.key.Len()),
			val: leaf.val,
		})
	}
	ref7 := refFromRelativeLeaves(under7)
	if len(ref7) != 33 || ref7[0] != 0xa0 {
		t.Fatalf("expected hashed ref, got %x", ref7)
	}

	hb := NewHashBuilder()
	hb.AddBranchRef(nibFromSlice([]byte{0x7}), ref7, false)
	mixed20 := hb.Root()

	if mixed20 != full20 {
		t.Fatalf("single cached hashed branch mismatch:\ngot  %x\nwant %x\nref=%x", mixed20, full20, ref7)
	}
}

func TestUpdatesOnlyCacheBranchRootChildren(t *testing.T) {
	makeKey := func(hexKey string) Nibbles { return nibsFromString(t, hexKey) }

	hb := NewHashBuilder().WithUpdates()
	hb.AddLeaf(makeKey("210"), []byte{0x01})
	hb.AddLeaf(makeKey("2f0"), []byte{0x02})
	hb.AddLeaf(makeKey("a10"), []byte{0x03})
	hb.Root()

	root := hb.Updates()[string(Nibbles{}.Pack())]
	if root == nil {
		t.Fatalf("missing root update")
	}
	if root.RefMask&(1<<2) == 0 {
		t.Fatalf("expected branch-root child 2 to be cached, refMask=%016b", root.RefMask)
	}
	if root.RefMask&(1<<10) != 0 {
		t.Fatalf("did not expect short-root child a to be cached, refMask=%016b", root.RefMask)
	}
}

func TestUpdatesRecacheShortRawBranchRefs(t *testing.T) {
	makeKey := func(hexKey string) Nibbles { return nibsFromString(t, hexKey) }

	shortRef7 := refFromRelativeLeaves([]testKV{
		{makeKey("10"), []byte{0x07}},
		{makeKey("20"), []byte{0x08}},
		{makeKey("30"), []byte{0x09}},
	})
	if len(shortRef7) == 33 && shortRef7[0] == 0xa0 {
		t.Fatalf("expected short ref, got hashed ref %x", shortRef7)
	}

	hb := NewHashBuilder().WithUpdates()
	hb.AddLeaf(makeKey("210"), []byte{0x01})
	hb.AddLeaf(makeKey("2f0"), []byte{0x02})
	hb.AddBranchRef(nibFromSlice([]byte{0x7}), shortRef7, false)
	hb.Root()

	root := hb.Updates()[string(Nibbles{}.Pack())]
	if root == nil {
		t.Fatalf("missing root update")
	}
	if root.RefMask&(1<<2) == 0 {
		t.Fatalf("expected branch-root child 2 to be cached, refMask=%016b", root.RefMask)
	}
	if root.RefMask&(1<<7) == 0 {
		t.Fatalf("expected short raw branch ref child 7 to be re-cached, refMask=%016b", root.RefMask)
	}
}

func TestReplayPreservesBranchRefWithoutTreeMask(t *testing.T) {
	makeKey := func(hexKey string) Nibbles { return nibsFromString(t, hexKey) }

	// Batch 1: child 2 is branch-rooted, but it has only leaf children, so the
	// root caches its ref while leaving TreeMask clear for nibble 2.
	batch1 := NewHashBuilder().WithUpdates()
	batch1.AddLeaf(makeKey("210"), []byte{0x01})
	batch1.AddLeaf(makeKey("2f0"), []byte{0x02})
	batch1.AddLeaf(makeKey("a10"), []byte{0x03})
	batch1.Root()

	root1 := batch1.Updates()[string(Nibbles{}.Pack())]
	if root1 == nil {
		t.Fatalf("missing root update from batch 1")
	}
	if root1.RefMask&(1<<2) == 0 {
		t.Fatalf("expected batch 1 to cache child 2, refMask=%016b", root1.RefMask)
	}
	if root1.TreeMask&(1<<2) != 0 {
		t.Fatalf("did not expect batch 1 to set treeMask for child 2, treeMask=%016b", root1.TreeMask)
	}

	refIdx := 0
	ref2 := root1.Refs[refIdx]

	// Batch 2: child 2 is unchanged and replayed from the cached ref, while the
	// sibling branch under a changes. We must preserve the cached ref for child 2
	// even though TreeMask for that child is still clear.
	batch2 := NewHashBuilder().WithUpdates()
	batch2.AddBranchRef(nibFromSlice([]byte{0x2}), ref2, false)
	batch2.AddLeaf(makeKey("a10"), []byte{0x04})
	batch2.Root()

	root2 := batch2.Updates()[string(Nibbles{}.Pack())]
	if root2 == nil {
		t.Fatalf("missing root update from batch 2")
	}
	if root2.RefMask&(1<<2) == 0 {
		t.Fatalf("expected batch 2 to preserve cached child 2, refMask=%016b", root2.RefMask)
	}
	if root2.TreeMask&(1<<2) != 0 {
		t.Fatalf("did not expect batch 2 to set treeMask for child 2, treeMask=%016b", root2.TreeMask)
	}
	if len(root2.Refs) == 0 || !bytes.Equal(root2.Refs[0], ref2) {
		t.Fatalf("batch 2 cached ref mismatch:\ngot  %x\nwant %x", root2.Refs[0], ref2)
	}
}

func TestParentRefFromLeafPlusCachedGrandchild(t *testing.T) {
	makeKey := func(hexKey string) Nibbles { return nibsFromString(t, hexKey) }

	// Full subtree under parent 66:
	// - child 1 has direct leaf 2 and unchanged branch child 8
	// - child d is a sibling leaf, forcing the parent to cache child 1
	fullChild1Ref := refFromRelativeLeaves([]testKV{
		{key: makeKey("2"), val: []byte{0x01}},
		{key: makeKey("85"), val: []byte{0x02}},
		{key: makeKey("8d"), val: []byte{0x03}},
	})
	cachedGrandchildRef := refFromRelativeLeaves([]testKV{
		{key: makeKey("5"), val: []byte{0x02}},
		{key: makeKey("d"), val: []byte{0x03}},
	})

	hb := NewHashBuilder().WithUpdates()
	hb.AddLeaf(makeKey("12"), []byte{0x01})
	hb.AddBranchRef(makeKey("18"), cachedGrandchildRef, false)
	hb.AddLeaf(makeKey("d0"), []byte{0x04})
	hb.Root()

	root := hb.Updates()[string(Nibbles{}.Pack())]
	if root == nil {
		t.Fatalf("missing root update")
	}
	if root.RefMask&(1<<1) == 0 {
		t.Fatalf("expected cached child 1 in root, refMask=%016b", root.RefMask)
	}
	gotRef := root.Refs[0]
	if !bytes.Equal(gotRef, fullChild1Ref) {
		t.Fatalf("root child 1 ref mismatch:\ngot  %x\nwant %x", gotRef, fullChild1Ref)
	}
}

func TestParentRefFromLeafPlusHashedCachedGrandchild(t *testing.T) {
	makeKey := func(hexKey string) Nibbles { return nibsFromString(t, hexKey) }

	fullChild1Ref := refFromRelativeLeaves([]testKV{
		{key: makeKey("2"), val: []byte{0x01}},
		{key: makeKey("80"), val: []byte{0x02}},
		{key: makeKey("81"), val: []byte{0x03}},
		{key: makeKey("82"), val: []byte{0x04}},
		{key: makeKey("83"), val: []byte{0x05}},
		{key: makeKey("84"), val: []byte{0x06}},
		{key: makeKey("85"), val: []byte{0x07}},
		{key: makeKey("86"), val: []byte{0x08}},
		{key: makeKey("87"), val: []byte{0x09}},
		{key: makeKey("88"), val: []byte{0x0a}},
	})
	cachedGrandchildRef := refFromRelativeLeaves([]testKV{
		{key: makeKey("0"), val: []byte{0x02}},
		{key: makeKey("1"), val: []byte{0x03}},
		{key: makeKey("2"), val: []byte{0x04}},
		{key: makeKey("3"), val: []byte{0x05}},
		{key: makeKey("4"), val: []byte{0x06}},
		{key: makeKey("5"), val: []byte{0x07}},
		{key: makeKey("6"), val: []byte{0x08}},
		{key: makeKey("7"), val: []byte{0x09}},
		{key: makeKey("8"), val: []byte{0x0a}},
	})
	if len(cachedGrandchildRef) != 33 || cachedGrandchildRef[0] != 0xa0 {
		t.Fatalf("expected hashed cached grandchild ref, got %x", cachedGrandchildRef)
	}

	hb := NewHashBuilder().WithUpdates()
	hb.AddLeaf(makeKey("12"), []byte{0x01})
	hb.AddBranchRef(makeKey("18"), cachedGrandchildRef, false)
	hb.AddLeaf(makeKey("d0"), []byte{0x0b})
	hb.Root()

	root := hb.Updates()[string(Nibbles{}.Pack())]
	if root == nil {
		t.Fatalf("missing root update")
	}
	if root.RefMask&(1<<1) == 0 {
		t.Fatalf("expected cached child 1 in root, refMask=%016b", root.RefMask)
	}
	gotRef := root.Refs[0]
	if !bytes.Equal(gotRef, fullChild1Ref) {
		t.Fatalf("root child 1 ref mismatch:\ngot  %x\nwant %x", gotRef, fullChild1Ref)
	}
}

func TestParentRefMatchesReal661Shape(t *testing.T) {
	makeKey := func(hexKey string) Nibbles { return nibsFromString(t, hexKey) }

	fullChild1Ref := refFromRelativeLeaves([]testKV{
		{key: makeKey("2b45a654ec4d6c44aa2611abf6e58e46efbbaae89a44f2a09980d7ea51146"), val: []byte{0x01}},
		{key: makeKey("8504290e64ebd3d3ff48d26f200d0341967609497ec87515b9e8e5aba24f7"), val: []byte{0x02}},
		{key: makeKey("8d27be9bc828fa5aaffd3d7af375a02d8fba08e9f2103c5f88aeae06c78c2"), val: []byte{0x03}},
	})
	cachedGrandchildRef := refFromRelativeLeaves([]testKV{
		{key: makeKey("504290e64ebd3d3ff48d26f200d0341967609497ec87515b9e8e5aba24f7"), val: []byte{0x02}},
		{key: makeKey("d27be9bc828fa5aaffd3d7af375a02d8fba08e9f2103c5f88aeae06c78c2"), val: []byte{0x03}},
	})
	if len(cachedGrandchildRef) != 33 || cachedGrandchildRef[0] != 0xa0 {
		t.Fatalf("expected hashed cached grandchild ref, got %x", cachedGrandchildRef)
	}

	hb := NewHashBuilder().WithUpdates()
	hb.AddLeaf(makeKey("12b45a654ec4d6c44aa2611abf6e58e46efbbaae89a44f2a09980d7ea51146"), []byte{0x01})
	hb.AddBranchRef(makeKey("18"), cachedGrandchildRef, false)
	hb.AddLeaf(makeKey("d0"), []byte{0x04})
	hb.Root()

	root := hb.Updates()[string(Nibbles{}.Pack())]
	if root == nil {
		t.Fatalf("missing root update")
	}
	if root.RefMask&(1<<1) == 0 {
		t.Fatalf("expected cached child 1 in root, refMask=%016b", root.RefMask)
	}
	gotRef := root.Refs[0]
	if !bytes.Equal(gotRef, fullChild1Ref) {
		t.Fatalf("root child 1 ref mismatch:\ngot  %x\nwant %x", gotRef, fullChild1Ref)
	}
}

func TestUpdateParentRefForMixedLeafAndBranchChild(t *testing.T) {
	makeKey := func(hexKey string) Nibbles { return nibsFromString(t, hexKey) }

	// Subtree 913 has:
	// - child 1 as a direct leaf
	// - child c as a branch-root subtree
	expectedRef913 := refFromRelativeLeaves([]testKV{
		{key: makeKey("1"), val: []byte{0x01}},
		{key: makeKey("ca"), val: []byte{0x02}},
		{key: makeKey("cf"), val: []byte{0x03}},
	})

	hb := NewHashBuilder().WithUpdates()
	hb.AddLeaf(makeKey("9131"), []byte{0x01})
	hb.AddLeaf(makeKey("913ca"), []byte{0x02})
	hb.AddLeaf(makeKey("913cf"), []byte{0x03})
	hb.AddLeaf(makeKey("91a0"), []byte{0x04}) // force parent node 91 to exist
	hb.Root()

	parent91 := hb.Updates()[string(makeKey("91").Pack())]
	if parent91 == nil {
		t.Fatalf("missing parent 91 update")
	}
	if parent91.RefMask&(1<<3) == 0 {
		t.Fatalf("expected cached child 3 in parent 91, refMask=%016b", parent91.RefMask)
	}
	gotRef913 := parent91.Refs[0]
	if !bytes.Equal(gotRef913, expectedRef913) {
		t.Fatalf("parent 91 child 3 ref mismatch:\ngot  %x\nwant %x", gotRef913, expectedRef913)
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
