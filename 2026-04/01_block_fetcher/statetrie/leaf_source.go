package statetrie

import (
	"encoding/binary"
	"math/bits"

	intTrie "block_fetcher/trie"
)

// AccountLeafSource wraps an MDBXLeafSource reading from HashedAccountState
// and transforms values from raw 104-byte account encoding to RLP-encoded
// types.StateAccount as required by the trie.
type AccountLeafSource struct {
	inner intTrie.LeafSource
}

func NewAccountLeafSource(inner intTrie.LeafSource) *AccountLeafSource {
	return &AccountLeafSource{inner: inner}
}

// Next returns the next (hashedAddress, rlpEncodedAccount) pair.
// Zero allocations — RLP is encoded manually into a fixed buffer.
func (s *AccountLeafSource) Next() ([]byte, []byte, error) {
	key, val, err := s.inner.Next()
	if err != nil || key == nil {
		return key, val, err
	}

	if len(val) < 104 {
		return nil, nil, nil // malformed account
	}

	// Raw format: [nonce:8][balance:32][codeHash:32][storageRoot:32][isMultiCoin:1]
	nonce := binary.BigEndian.Uint64(val[0:8])
	balance := val[8:40]       // 32 bytes, big-endian
	codeHash := val[40:72]     // 32 bytes
	storageRoot := val[72:104] // 32 bytes
	isMultiCoin := len(val) >= 105 && val[104] != 0

	// StateAccount RLP: list([nonce, balance, storageRoot, codeHash, extra])
	// extra = isMultiCoin boolean: true → 0x01, false → 0x80
	//
	// Encode into a stack buffer, then copy to a fresh slice.
	// Avoids rlp.EncodeToBytes + pseudo.From[bool] allocations.
	var buf [160]byte
	off := 3 // reserve up to 3 bytes for list header

	// nonce (uint64)
	off += rlpPutUint64(buf[off:], nonce)

	// balance (big int, trimmed)
	trimBal := trimLeadingZerosBytes(balance)
	off += rlpPutBytes(buf[off:], trimBal)

	// storageRoot (32 bytes — always full, never trimmed)
	off += rlpPutFixedBytes(buf[off:], storageRoot)

	// codeHash (32 bytes)
	off += rlpPutFixedBytes(buf[off:], codeHash)

	// extra: isMultiCoin boolean
	if isMultiCoin {
		buf[off] = 0x01
	} else {
		buf[off] = 0x80
	}
	off++

	// Now fill the list header.
	payloadLen := off - 3
	// Build the final RLP with list header, copy to owned slice.
	var start int
	if payloadLen <= 55 {
		start = 2
		buf[start] = 0xc0 + byte(payloadLen)
	} else {
		lenBytes := uintBytes(uint64(payloadLen))
		start = 3 - 1 - lenBytes
		buf[start] = 0xf7 + byte(lenBytes)
		for i := lenBytes; i > 0; i-- {
			buf[start+i] = byte(payloadLen >> (8 * (lenBytes - i)))
		}
	}
	out := make([]byte, off-start)
	copy(out, buf[start:off])
	return key, out, nil
}

// rlpPutUint64 encodes a uint64 as RLP into dst, returns bytes written.
func rlpPutUint64(dst []byte, v uint64) int {
	if v == 0 {
		dst[0] = 0x80
		return 1
	}
	if v <= 0x7f {
		dst[0] = byte(v)
		return 1
	}
	n := uintBytes(v)
	dst[0] = 0x80 + byte(n)
	for i := n; i > 0; i-- {
		dst[i] = byte(v)
		v >>= 8
	}
	return 1 + n
}

// rlpPutBytes encodes a byte string (trimmed, variable length) as RLP.
func rlpPutBytes(dst []byte, b []byte) int {
	if len(b) == 0 {
		dst[0] = 0x80
		return 1
	}
	if len(b) == 1 && b[0] <= 0x7f {
		dst[0] = b[0]
		return 1
	}
	if len(b) <= 55 {
		dst[0] = 0x80 + byte(len(b))
		copy(dst[1:], b)
		return 1 + len(b)
	}
	lenBytes := uintBytes(uint64(len(b)))
	dst[0] = 0xb7 + byte(lenBytes)
	for i := lenBytes; i > 0; i-- {
		dst[i] = byte(len(b) >> (8 * (lenBytes - i)))
	}
	copy(dst[1+lenBytes:], b)
	return 1 + lenBytes + len(b)
}

// rlpPutFixedBytes encodes a 32-byte value as RLP string (always 33 bytes: 0xa0 + 32).
func rlpPutFixedBytes(dst []byte, b []byte) int {
	dst[0] = 0xa0 // 0x80 + 32
	copy(dst[1:], b[:32])
	return 33
}

func uintBytes(v uint64) int {
	return (bits.Len64(v) + 7) / 8
}

func trimLeadingZerosBytes(b []byte) []byte {
	for len(b) > 0 && b[0] == 0 {
		b = b[1:]
	}
	return b
}

// StorageLeafSource wraps an MDBXLeafSource reading from HashedStorageState
// and RLP-encodes the trimmed storage values as required by the trie.
type StorageLeafSource struct {
	inner intTrie.LeafSource
}

func NewStorageLeafSource(inner intTrie.LeafSource) *StorageLeafSource {
	return &StorageLeafSource{inner: inner}
}

// Next returns the next (hashedSlot, rlpEncodedValue) pair.
func (s *StorageLeafSource) Next() ([]byte, []byte, error) {
	key, val, err := s.inner.Next()
	if err != nil || key == nil {
		return key, val, err
	}
	return key, rlpEncodeBytesAlloc(val), nil
}

// rlpEncodeBytesAlloc encodes a byte string to RLP. Allocates minimally.
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
	lenBytes := uintBytes(uint64(len(val)))
	out := make([]byte, 1+lenBytes+len(val))
	out[0] = 0xb7 + byte(lenBytes)
	for i := lenBytes; i > 0; i-- {
		out[i] = byte(len(val) >> (8 * (lenBytes - i)))
	}
	copy(out[1+lenBytes:], val)
	return out
}
