package trie

import (
	"encoding/binary"
	"fmt"
	"math/bits"
)

// BranchNodeCompact represents an intermediate branch node stored in the DB.
// It matches reth's BranchNodeCompact encoding format.
type BranchNodeCompact struct {
	StateMask uint16     // which of 16 children exist in state
	TreeMask  uint16     // which children have subtrees stored in DB
	HashMask  uint16     // which children have hashes stored
	Hashes    [][32]byte // one hash per set bit in HashMask
	RootHash  *[32]byte  // optional cached hash of this node
}

const hashLen = 32

// Encode serializes the branch node for DB storage.
//
// Format (matching reth's Compact encoding via the bytes crate):
//
//	state_mask: 2 bytes BE
//	tree_mask:  2 bytes BE
//	hash_mask:  2 bytes BE
//	root_hash:  32 bytes (only if present, written before hashes)
//	hashes:     N * 32 bytes (N = popcount(hash_mask))
func (b *BranchNodeCompact) Encode() []byte {
	numHashes := len(b.Hashes)
	size := 6 + numHashes*hashLen
	if b.RootHash != nil {
		size += hashLen
	}

	buf := make([]byte, 0, size)

	// Masks in big-endian (bytes crate put_u16/get_u16 default).
	buf = binary.BigEndian.AppendUint16(buf, b.StateMask)
	buf = binary.BigEndian.AppendUint16(buf, b.TreeMask)
	buf = binary.BigEndian.AppendUint16(buf, b.HashMask)

	// Root hash comes before the child hashes when present.
	if b.RootHash != nil {
		buf = append(buf, b.RootHash[:]...)
	}

	// Child hashes.
	for i := range b.Hashes {
		buf = append(buf, b.Hashes[i][:]...)
	}

	return buf
}

// DecodeBranchNode deserializes a branch node from DB storage.
func DecodeBranchNode(data []byte) (*BranchNodeCompact, error) {
	if len(data) < 6 {
		return nil, fmt.Errorf("branch node too short: %d bytes", len(data))
	}

	// The payload after the 6-byte header must be a multiple of 32 bytes,
	// because it holds only 32-byte hashes.
	if (len(data)-6)%hashLen != 0 {
		return nil, fmt.Errorf("branch node has invalid length: %d bytes", len(data))
	}

	stateMask := binary.BigEndian.Uint16(data[0:2])
	treeMask := binary.BigEndian.Uint16(data[2:4])
	hashMask := binary.BigEndian.Uint16(data[4:6])

	data = data[6:]
	numHashes := len(data) / hashLen
	expectedHashes := bits.OnesCount16(hashMask)

	var rootHash *[32]byte

	// If there is one extra hash beyond what HashMask accounts for,
	// the first hash is the root hash.
	if numHashes == expectedHashes+1 {
		rh := [32]byte{}
		copy(rh[:], data[:hashLen])
		rootHash = &rh
		data = data[hashLen:]
		numHashes--
	} else if numHashes != expectedHashes {
		return nil, fmt.Errorf(
			"branch node hash count mismatch: have %d hashes, hash_mask has %d bits set",
			numHashes, expectedHashes,
		)
	}

	hashes := make([][32]byte, numHashes)
	for i := range hashes {
		copy(hashes[i][:], data[i*hashLen:(i+1)*hashLen])
	}

	return &BranchNodeCompact{
		StateMask: stateMask,
		TreeMask:  treeMask,
		HashMask:  hashMask,
		Hashes:    hashes,
		RootHash:  rootHash,
	}, nil
}
