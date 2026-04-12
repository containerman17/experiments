package trie

import "testing"

func TestPrefixSetReset(t *testing.T) {
	psb := NewPrefixSetBuilder()
	psb.AddKey(nibFromSlice([]byte{0x1, 0x2}))
	psb.AddKey(nibFromSlice([]byte{0x6, 0x6, 0x1, 0x2}))
	ps := psb.Build()

	if !ps.ContainsPrefix(nibFromSlice([]byte{0x6, 0x6})) {
		t.Fatal("expected prefix 66 to match on first pass")
	}
	if ps.ContainsPrefix(nibFromSlice([]byte{0x1})) {
		t.Fatal("did not expect earlier prefix 1 to match after cursor advanced")
	}

	ps.Reset()
	if !ps.ContainsPrefix(nibFromSlice([]byte{0x1})) {
		t.Fatal("expected reset prefix set to match earlier prefix 1")
	}
}

func TestPrefixSetContainsPrefixUnordered(t *testing.T) {
	psb := NewPrefixSetBuilder()
	psb.AddKey(nibFromSlice([]byte{0x6, 0x6, 0x1, 0x2}))
	psb.AddKey(nibFromSlice([]byte{0x1, 0x2}))
	ps := psb.Build()

	if !ps.ContainsPrefixUnordered(nibFromSlice([]byte{0x6, 0x6})) {
		t.Fatal("expected unordered lookup to match prefix 66")
	}
	if !ps.ContainsPrefixUnordered(nibFromSlice([]byte{0x1})) {
		t.Fatal("expected unordered lookup to match prefix 1")
	}
	if ps.ContainsPrefixUnordered(nibFromSlice([]byte{0x7})) {
		t.Fatal("did not expect unordered lookup to match prefix 7")
	}
}
