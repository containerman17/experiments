package trie

const hexDigits = "0123456789abcdef"

// Nibbles represents a path of half-bytes (nibbles).
type Nibbles struct {
	data []byte // packed nibbles, 2 per byte
	len  int    // number of nibbles (may be odd)
}

// NewNibbles creates Nibbles from raw bytes (each byte = 2 nibbles).
func NewNibbles(data []byte) Nibbles {
	cp := make([]byte, len(data))
	copy(cp, data)
	return Nibbles{data: cp, len: len(data) * 2}
}

// FromHex creates Nibbles from a hex-encoded key (like keccak hash).
// Each byte of input becomes 2 nibbles.
func FromHex(key []byte) Nibbles {
	return NewNibbles(key)
}

// Len returns the number of nibbles.
func (n Nibbles) Len() int {
	return n.len
}

// At returns the nibble at position i.
func (n Nibbles) At(i int) byte {
	byteIdx := i / 2
	if i%2 == 0 {
		return n.data[byteIdx] >> 4
	}
	return n.data[byteIdx] & 0x0f
}

// Slice returns a sub-range of nibbles [from, to).
func (n Nibbles) Slice(from, to int) Nibbles {
	length := to - from
	if length == 0 {
		return Nibbles{}
	}

	// Calculate how many bytes we need
	numBytes := (length + 1) / 2
	data := make([]byte, numBytes)

	for i := 0; i < length; i++ {
		nib := n.At(from + i)
		byteIdx := i / 2
		if i%2 == 0 {
			data[byteIdx] = nib << 4
		} else {
			data[byteIdx] |= nib
		}
	}

	return Nibbles{data: data, len: length}
}

// Prefix returns the first n nibbles.
func (n Nibbles) Prefix(length int) Nibbles {
	return n.Slice(0, length)
}

// HasPrefix returns true if these nibbles start with the given prefix.
func (n Nibbles) HasPrefix(prefix Nibbles) bool {
	if prefix.len > n.len {
		return false
	}
	return n.CommonPrefix(prefix) == prefix.len
}

// CommonPrefix returns the length of the common prefix between two nibble paths.
func (n Nibbles) CommonPrefix(other Nibbles) int {
	maxLen := n.len
	if other.len < maxLen {
		maxLen = other.len
	}
	for i := 0; i < maxLen; i++ {
		if n.At(i) != other.At(i) {
			return i
		}
	}
	return maxLen
}

// Equal returns true if two nibble paths are equal.
func (n Nibbles) Equal(other Nibbles) bool {
	if n.len != other.len {
		return false
	}
	return n.CommonPrefix(other) == n.len
}

// Compare returns -1, 0, or 1 for lexicographic comparison.
func (n Nibbles) Compare(other Nibbles) int {
	maxLen := n.len
	if other.len < maxLen {
		maxLen = other.len
	}
	for i := 0; i < maxLen; i++ {
		a, b := n.At(i), other.At(i)
		if a < b {
			return -1
		}
		if a > b {
			return 1
		}
	}
	if n.len < other.len {
		return -1
	}
	if n.len > other.len {
		return 1
	}
	return 0
}

// Pack encodes nibbles into bytes for DB storage.
// Format: [length_byte] [packed_nibbles...]
// If odd number of nibbles, last nibble is in high 4 bits of last byte.
func (n Nibbles) Pack() []byte {
	numBytes := (n.len + 1) / 2
	result := make([]byte, 1+numBytes)
	result[0] = byte(n.len)

	for i := 0; i < n.len; i++ {
		nib := n.At(i)
		byteIdx := i / 2
		if i%2 == 0 {
			result[1+byteIdx] = nib << 4
		} else {
			result[1+byteIdx] |= nib
		}
	}

	return result
}

// Unpack decodes nibbles from the packed DB format.
func Unpack(data []byte) Nibbles {
	if len(data) == 0 {
		return Nibbles{}
	}
	length := int(data[0])
	numBytes := (length + 1) / 2
	packed := make([]byte, numBytes)
	copy(packed, data[1:])
	return Nibbles{data: packed, len: length}
}

// Append adds a nibble to the end.
func (n Nibbles) Append(nibble byte) Nibbles {
	newLen := n.len + 1
	numBytes := (newLen + 1) / 2

	data := make([]byte, numBytes)
	// Copy existing packed data
	copy(data, n.data)

	// Set the new nibble
	byteIdx := n.len / 2
	if n.len%2 == 0 {
		data[byteIdx] = nibble << 4
	} else {
		data[byteIdx] |= nibble
	}

	return Nibbles{data: data, len: newLen}
}

// Bytes returns the underlying packed data (for DB keys).
func (n Nibbles) Bytes() []byte {
	return n.data
}

// String returns hex string representation.
func (n Nibbles) String() string {
	if n.len == 0 {
		return ""
	}
	buf := make([]byte, n.len)
	for i := 0; i < n.len; i++ {
		buf[i] = hexDigits[n.At(i)]
	}
	return string(buf)
}
