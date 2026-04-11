package statetrie

import (
	"encoding/binary"
	"math/bits"

	"github.com/ava-labs/libevm/common"
	"github.com/ava-labs/libevm/core/types"
	"github.com/ava-labs/libevm/rlp"
	"github.com/holiman/uint256"

	"block_fetcher/store"
	intTrie "block_fetcher/trie"
)

// AccountLeafSource wraps an MDBXLeafSource reading from HashedAccountState
// and transforms values from raw 104-byte account encoding to RLP-encoded
// types.StateAccount as required by the trie.
type AccountLeafSource struct {
	inner intTrie.LeafSource
	// Reusable buffers to reduce allocations in the hot path.
	sa  types.StateAccount
	bal uint256.Int
}

// NewAccountLeafSource creates a LeafSource that reads from HashedAccountState
// and RLP-encodes values for the trie HashBuilder.
func NewAccountLeafSource(inner intTrie.LeafSource) *AccountLeafSource {
	s := &AccountLeafSource{inner: inner}
	s.sa.CodeHash = make([]byte, 32)
	return s
}

// Next returns the next (hashedAddress, rlpEncodedAccount) pair.
func (s *AccountLeafSource) Next() ([]byte, []byte, error) {
	key, val, err := s.inner.Next()
	if err != nil || key == nil {
		return key, val, err
	}

	// Decode the raw 104-byte account from HashedAccountState.
	// Format: [nonce:8][balance:32][codeHash:32][storageRoot:32]
	if len(val) >= 104 {
		s.sa.Nonce = binary.BigEndian.Uint64(val[0:8])
		s.bal.SetBytes32(val[8:40])
		s.sa.Balance = &s.bal
		copy(s.sa.CodeHash, val[40:72])
		copy(s.sa.Root[:], val[72:104])
	} else {
		// Fallback for unexpected format.
		acct := store.DecodeAccount(val)
		s.sa.Nonce = acct.Nonce
		s.bal.SetBytes32(acct.Balance[:])
		s.sa.Balance = &s.bal
		copy(s.sa.CodeHash, acct.CodeHash[:])
		s.sa.Root = common.Hash(acct.StorageRoot)
	}

	encoded, err := rlp.EncodeToBytes(&s.sa)
	if err != nil {
		return nil, nil, err
	}

	return key, encoded, nil
}

// StorageLeafSource wraps an MDBXLeafSource reading from HashedStorageState
// and RLP-encodes the trimmed storage values as required by the trie.
type StorageLeafSource struct {
	inner intTrie.LeafSource
}

// NewStorageLeafSource creates a LeafSource that reads from HashedStorageState
// and RLP-encodes values for the trie HashBuilder.
func NewStorageLeafSource(inner intTrie.LeafSource) *StorageLeafSource {
	return &StorageLeafSource{inner: inner}
}

// Next returns the next (hashedSlot, rlpEncodedValue) pair.
func (s *StorageLeafSource) Next() ([]byte, []byte, error) {
	key, val, err := s.inner.Next()
	if err != nil || key == nil {
		return key, val, err
	}

	// Fast-path RLP encoding for storage values (small byte strings).
	encoded := rlpEncodeBytesAlloc(val)
	return key, encoded, nil
}

// rlpEncodeBytesAlloc encodes a byte string to RLP with a fresh allocation.
// Avoids the overhead of rlp.EncodeToBytes for simple byte strings.
func rlpEncodeBytesAlloc(val []byte) []byte {
	if len(val) == 1 && val[0] <= 0x7f {
		return []byte{val[0]}
	}
	if len(val) <= 55 {
		out := make([]byte, 1+len(val))
		out[0] = 0x80 + byte(len(val))
		copy(out[1:], val)
		return out
	}
	lenBytes := (bits.Len(uint(len(val))) + 7) / 8
	out := make([]byte, 1+lenBytes+len(val))
	out[0] = 0xb7 + byte(lenBytes)
	for i := lenBytes; i > 0; i-- {
		out[i] = byte(len(val) >> (8 * (lenBytes - i)))
	}
	copy(out[1+lenBytes:], val)
	return out
}
