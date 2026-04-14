package trie

import (
	"bytes"
	"testing"
)

func TestSuccessorRawKeyEvenLength(t *testing.T) {
	cases := []struct {
		name     string
		nibbles  Nibbles
		expected []byte
	}{
		{
			name:     "2 nibbles [3,a]",
			nibbles:  NewNibbles([]byte{0x3a}),
			expected: []byte{0x3b},
		},
		{
			name:     "4 nibbles [1,2,3,4]",
			nibbles:  NewNibbles([]byte{0x12, 0x34}),
			expected: []byte{0x12, 0x35},
		},
		{
			name:     "2 nibbles [f,e]",
			nibbles:  NewNibbles([]byte{0xfe}),
			expected: []byte{0xff},
		},
		{
			name:     "2 nibbles [f,f] - carry propagation",
			nibbles:  NewNibbles([]byte{0xff}),
			expected: nil, // covers entire keyspace
		},
		{
			name:     "4 nibbles [a,b,f,f] - carry",
			nibbles:  NewNibbles([]byte{0xab, 0xff}),
			expected: []byte{0xac, 0x00},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.nibbles.SuccessorRawKey()
			if !bytes.Equal(got, tc.expected) {
				t.Errorf("SuccessorRawKey() = %x, want %x", got, tc.expected)
			}
		})
	}
}

func TestSuccessorRawKeyOddLength(t *testing.T) {
	// Odd-length nibble paths: the successor should produce a raw key
	// that's the first byte sequence NOT under the nibble prefix.

	// 1 nibble [a] -> successor [b] -> raw key [0xb0]
	// Keys under [a]: [0xa0..] through [0xaf..]
	// First key NOT under [a]: [0xb0..]
	n1 := NewNibbles([]byte{0xa0}) // gives nibbles [a, 0]
	n1odd := n1.Prefix(1)          // just [a]
	got := n1odd.SuccessorRawKey()
	if !bytes.Equal(got, []byte{0xb0}) {
		t.Errorf("1-nibble [a]: got %x, want b0", got)
	}

	// 3 nibbles [3, a, 5] -> successor [3, a, 6] -> raw key [0x3a, 0x60]
	// Keys under [3,a,5]: [0x3a, 0x50..] through [0x3a, 0x5f..]
	// First key NOT under [3,a,5]: [0x3a, 0x60..]
	n3 := NewNibbles([]byte{0x3a, 0x50}) // nibbles [3, a, 5, 0]
	n3odd := n3.Prefix(3)                 // just [3, a, 5]
	got = n3odd.SuccessorRawKey()
	if !bytes.Equal(got, []byte{0x3a, 0x60}) {
		t.Errorf("3-nibble [3,a,5]: got %x, want 3a60", got)
	}

	// 1 nibble [f] -> all ff -> nil (covers entire keyspace under f)
	nf := NewNibbles([]byte{0xf0})
	nfodd := nf.Prefix(1)
	got = nfodd.SuccessorRawKey()
	if got != nil {
		t.Errorf("1-nibble [f]: got %x, want nil", got)
	}

	// 3 nibbles [f, f, f] -> nil
	nfff := NewNibbles([]byte{0xff, 0xf0})
	nfffodd := nfff.Prefix(3)
	got = nfffodd.SuccessorRawKey()
	if got != nil {
		t.Errorf("3-nibble [f,f,f]: got %x, want nil", got)
	}

	// 3 nibbles [a, b, f] -> [a, c, 0] -> raw key [0xac, 0x00]
	nabf := NewNibbles([]byte{0xab, 0xf0})
	nabfodd := nabf.Prefix(3)
	got = nabfodd.SuccessorRawKey()
	if !bytes.Equal(got, []byte{0xac, 0x00}) {
		t.Errorf("3-nibble [a,b,f]: got %x, want ac00", got)
	}
}

func TestSuccessorRawKeySeekCorrectness(t *testing.T) {
	// Verify that for various prefixes, the successor raw key correctly
	// partitions 32-byte keys into "under prefix" and "not under prefix".

	prefixes := []Nibbles{
		NewNibbles([]byte{0x3a}).Prefix(1),         // [3]
		NewNibbles([]byte{0x3a}),                    // [3, a]
		NewNibbles([]byte{0x3a, 0x50}).Prefix(3),    // [3, a, 5]
		NewNibbles([]byte{0xab, 0xcd}),              // [a, b, c, d]
		NewNibbles([]byte{0x00}),                    // [0, 0]
		NewNibbles([]byte{0x00}).Prefix(1),           // [0]
	}

	for _, prefix := range prefixes {
		successor := prefix.SuccessorRawKey()
		if successor == nil {
			continue
		}

		// Generate a key that IS under the prefix (last possible)
		underKey := make([]byte, 32)
		for i := 0; i < prefix.Len(); i++ {
			nib := prefix.At(i)
			if i%2 == 0 {
				underKey[i/2] = nib << 4
				if i == prefix.Len()-1 {
					underKey[i/2] |= 0x0f // fill low nibble with f
				}
			} else {
				underKey[i/2] |= nib
			}
		}
		// Fill rest with 0xff
		startByte := (prefix.Len() + 1) / 2
		for i := startByte; i < 32; i++ {
			underKey[i] = 0xff
		}

		// This key should be < successor
		if bytes.Compare(underKey, successor) >= 0 {
			t.Errorf("prefix %s: underKey %x should be < successor %x",
				prefix.String(), underKey, successor)
		}

		// Generate a key that is NOT under the prefix (first after)
		afterKey := make([]byte, 32)
		copy(afterKey, successor)

		if bytes.Compare(afterKey, successor) < 0 {
			t.Errorf("prefix %s: afterKey %x should be >= successor %x",
				prefix.String(), afterKey, successor)
		}
	}
}
