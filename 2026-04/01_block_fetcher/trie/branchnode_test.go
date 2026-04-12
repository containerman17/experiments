package trie

import (
	"bytes"
	"testing"
)

func TestBranchNodeCompactEncodeDecodeRoundTrip(t *testing.T) {
	rootHash := [32]byte{0xaa, 0xbb, 0xcc, 0xdd}
	original := &BranchNodeCompact{
		StateMask: 0b0000010100010011,
		TreeMask:  0b0000010000010001,
		RefMask:   0b0000010100000001,
		Refs: [][]byte{
			{0xc6, 0x20, 0x01},
			append([]byte{0xa0}, bytes.Repeat([]byte{0x44}, 32)...),
			{0xde, 0xad, 0xbe, 0xef},
		},
		RootHash: &rootHash,
	}

	encoded := original.Encode()
	decoded, err := DecodeBranchNode(encoded)
	if err != nil {
		t.Fatalf("DecodeBranchNode() error = %v", err)
	}

	if decoded.StateMask != original.StateMask {
		t.Fatalf("StateMask = %016b, want %016b", decoded.StateMask, original.StateMask)
	}
	if decoded.TreeMask != original.TreeMask {
		t.Fatalf("TreeMask = %016b, want %016b", decoded.TreeMask, original.TreeMask)
	}
	if decoded.RefMask != original.RefMask {
		t.Fatalf("RefMask = %016b, want %016b", decoded.RefMask, original.RefMask)
	}
	if decoded.RootHash == nil {
		t.Fatal("RootHash = nil, want value")
	}
	if *decoded.RootHash != *original.RootHash {
		t.Fatalf("RootHash = %x, want %x", *decoded.RootHash, *original.RootHash)
	}
	if len(decoded.Refs) != len(original.Refs) {
		t.Fatalf("len(Refs) = %d, want %d", len(decoded.Refs), len(original.Refs))
	}
	for i := range original.Refs {
		if !bytes.Equal(decoded.Refs[i], original.Refs[i]) {
			t.Fatalf("Refs[%d] = %x, want %x", i, decoded.Refs[i], original.Refs[i])
		}
	}
}
