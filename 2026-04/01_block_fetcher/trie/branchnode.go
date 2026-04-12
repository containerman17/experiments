package trie

import (
	"encoding/binary"
	"fmt"
)

// BranchNodeCompact represents an intermediate branch node stored in the DB.
// It stores the exact child references as embedded by the parent:
// raw RLP (<32 bytes) or rlp(hash) (33 bytes).
type BranchNodeCompact struct {
	StateMask uint16     // which of 16 children exist in state
	TreeMask  uint16     // which children have subtrees stored in DB
	RefMask   uint16     // which children have cached subtree references stored
	Refs      [][]byte   // one ref per set bit in RefMask
	RootHash  *[32]byte  // optional cached hash of this node
}

const (
	hashLen        = 32
	branchFlagRoot = 1 << 0
)

// Encode serializes the branch node for DB storage.
//
// Format (matching reth's Compact encoding via the bytes crate):
//
//	state_mask: 2 bytes BE
//	tree_mask:  2 bytes BE
//	ref_mask:   2 bytes BE
//	flags:      1 byte
//	root_hash:  32 bytes (only if present, written before hashes)
//	refs:       N * [len:1 | ref:len]
func (b *BranchNodeCompact) Encode() []byte {
	size := 7
	if b.RootHash != nil {
		size += hashLen
	}
	for _, ref := range b.Refs {
		size += 1 + len(ref)
	}

	buf := make([]byte, 0, size)

	// Masks in big-endian (bytes crate put_u16/get_u16 default).
	buf = binary.BigEndian.AppendUint16(buf, b.StateMask)
	buf = binary.BigEndian.AppendUint16(buf, b.TreeMask)
	buf = binary.BigEndian.AppendUint16(buf, b.RefMask)

	// Root hash comes before the child hashes when present.
	var flags byte
	if b.RootHash != nil {
		flags |= branchFlagRoot
	}
	buf = append(buf, flags)

	if b.RootHash != nil {
		buf = append(buf, b.RootHash[:]...)
	}

	for _, ref := range b.Refs {
		buf = append(buf, byte(len(ref)))
		buf = append(buf, ref...)
	}

	return buf
}

// DecodeBranchNode deserializes a branch node from DB storage.
func DecodeBranchNode(data []byte) (*BranchNodeCompact, error) {
	if len(data) < 7 {
		return nil, fmt.Errorf("branch node too short: %d bytes", len(data))
	}

	stateMask := binary.BigEndian.Uint16(data[0:2])
	treeMask := binary.BigEndian.Uint16(data[2:4])
	refMask := binary.BigEndian.Uint16(data[4:6])
	flags := data[6]

	data = data[7:]

	var rootHash *[32]byte
	if flags&branchFlagRoot != 0 {
		if len(data) < hashLen {
			return nil, fmt.Errorf("branch node root hash truncated: %d bytes", len(data))
		}
		rh := [32]byte{}
		copy(rh[:], data[:hashLen])
		rootHash = &rh
		data = data[hashLen:]
	}

	expectedRefs := 0
	for mask := refMask; mask != 0; mask &= mask - 1 {
		expectedRefs++
	}

	refs := make([][]byte, 0, expectedRefs)
	for i := 0; i < expectedRefs; i++ {
		if len(data) == 0 {
			return nil, fmt.Errorf("branch node ref count mismatch: expected %d refs, got %d", expectedRefs, i)
		}
		refLen := int(data[0])
		data = data[1:]
		if len(data) < refLen {
			return nil, fmt.Errorf("branch node ref truncated: need %d bytes, have %d", refLen, len(data))
		}
		ref := make([]byte, refLen)
		copy(ref, data[:refLen])
		refs = append(refs, ref)
		data = data[refLen:]
	}
	if len(data) != 0 {
		return nil, fmt.Errorf("branch node has trailing bytes: %d", len(data))
	}

	return &BranchNodeCompact{
		StateMask: stateMask,
		TreeMask:  treeMask,
		RefMask:   refMask,
		Refs:      refs,
		RootHash:  rootHash,
	}, nil
}
