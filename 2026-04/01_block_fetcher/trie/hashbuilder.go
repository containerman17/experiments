package trie

import (
	"github.com/ava-labs/libevm/crypto"
	"github.com/ava-labs/libevm/rlp"
)

// EmptyRootHash is keccak256(RLP("")) = keccak256(0x80).
var EmptyRootHash = crypto.Keccak256Hash([]byte{0x80})

// HashBuilder computes the MPT root hash from sorted (key, value) pairs.
// This is a port of alloy-trie's HashBuilder.
//
// The builder processes entries (leaves and branches) in sorted nibble order.
// It maintains a stack of partially-built RLP-encoded nodes. When a new entry
// arrives, the builder "closes" all nodes that are complete (their key doesn't
// share a prefix with the new entry), RLP-encoding and hashing them as needed.
type HashBuilder struct {
	key         Nibbles // current key being processed
	value       []byte  // current value (leaf bytes or cached child reference)
	isReference bool    // true if value is a cached subtree reference rather than leaf data
	stack       []stackItem

	stateMasks []uint16 // bitmask of active children at each depth
	treeMasks  []uint16 // which children have a stored branch node in DB
	hashMasks  []uint16 // cached child-reference bits (historical name kept internally)

	childNodeStored bool

	// Collected updates for persistence
	updates map[string]*BranchNodeCompact
}

type stackItem struct {
	ref          []byte
	rootIsBranch bool
}

// NewHashBuilder creates a new hash builder.
func NewHashBuilder() *HashBuilder {
	return &HashBuilder{}
}

// WithUpdates enables collecting branch node updates for DB persistence.
func (h *HashBuilder) WithUpdates() *HashBuilder {
	h.updates = make(map[string]*BranchNodeCompact)
	return h
}

// AddLeaf adds a leaf entry (account or storage value).
// key must be the full nibble path (64 nibbles for keccak hash).
// value is the RLP-encoded account or storage value.
// Keys must be added in strictly increasing sorted order.
func (h *HashBuilder) AddLeaf(key Nibbles, value []byte) {
	if h.key.Len() > 0 {
		h.update(key)
	}
	h.key = key
	h.value = make([]byte, len(value))
	copy(h.value, value)
	h.isReference = false
}

// AddBranch adds a known cached branch-root hash (from DB, for unchanged subtrees).
// key is the nibble path prefix.
// childNodeStored reports whether this cached child has a stored branch node
// in the DB that the walker can descend into on a future update.
func (h *HashBuilder) AddBranch(key Nibbles, hash [32]byte, childNodeStored bool) {
	h.AddBranchRef(key, wordRLP(hash), childNodeStored)
}

// AddBranchRef adds a known cached branch-root reference.
// ref must be exactly what the parent would embed for this child:
// either raw RLP (<32 bytes) or an RLP-encoded 32-byte hash (33 bytes).
//
// childNodeStored is intentionally separate from cacheability:
// a cached child can be branch-rooted and therefore safe to replay opaquely,
// while still having no stored branch node below it (TreeMask=0).
func (h *HashBuilder) AddBranchRef(key Nibbles, ref []byte, childNodeStored bool) {
	if h.key.Len() > 0 {
		h.update(key)
	} else if key.Len() == 0 {
		// Special case: pushing root hash directly
		refCopy := make([]byte, len(ref))
		copy(refCopy, ref)
		h.stack = append(h.stack, stackItem{ref: refCopy, rootIsBranch: true})
	}
	h.key = key
	h.value = make([]byte, len(ref))
	copy(h.value, ref)
	h.isReference = true
	h.childNodeStored = childNodeStored
}

// Root finalizes and returns the root hash.
func (h *HashBuilder) Root() [32]byte {
	if h.key.Len() > 0 {
		h.update(Nibbles{}) // empty succeeding key to flush everything
		h.key = Nibbles{}
		h.value = nil
	}
	return h.currentRoot()
}

// Updates returns the branch node updates to persist.
func (h *HashBuilder) Updates() map[string]*BranchNodeCompact {
	if h.updates == nil {
		return nil
	}
	return h.updates
}

// StackTop returns the current root node reference bytes after Root() has been called.
func (h *HashBuilder) StackTop() []byte {
	if len(h.stack) == 0 {
		return nil
	}
	top := make([]byte, len(h.stack[len(h.stack)-1].ref))
	copy(top, h.stack[len(h.stack)-1].ref)
	return top
}

func (h *HashBuilder) currentRoot() [32]byte {
	if len(h.stack) > 0 {
		top := h.stack[len(h.stack)-1].ref
		if hash, ok := rlpNodeAsHash(top); ok {
			return hash
		}
		return crypto.Keccak256Hash(top)
	}
	return EmptyRootHash
}

// update is the core algorithm. When a new key (succeeding) arrives, it closes
// all trie nodes that are complete based on the common prefix.
func (h *HashBuilder) update(succeeding Nibbles) {
	buildExtensions := false
	current := h.key

	for i := 0; ; i++ {
		precedingExists := len(h.stateMasks) > 0
		precedingLen := 0
		if len(h.stateMasks) > 0 {
			precedingLen = len(h.stateMasks) - 1
		}

		commonPrefixLen := succeeding.CommonPrefix(current)
		length := precedingLen
		if commonPrefixLen > length {
			length = commonPrefixLen
		}

		// The extra digit at position `length` in current
		extraDigit := current.At(length)
		if len(h.stateMasks) <= length {
			newLen := length + 1
			for len(h.stateMasks) < newLen {
				h.stateMasks = append(h.stateMasks, 0)
			}
		}
		h.stateMasks[length] |= 1 << extraDigit

		// Resize tree/hash masks to fit current key length
		if len(h.treeMasks) < current.Len() {
			h.resizeMasks(current.Len())
		}

		lenFrom := length
		if succeeding.Len() > 0 || precedingExists {
			lenFrom = length + 1
		}

		// The key without the common prefix
		shortNodeKey := current.Slice(lenFrom, current.Len())

		// Build the node to push onto the stack
		if !buildExtensions {
			if !h.isReference {
				// Leaf node
				rlpData := rlpEncodeLeafNode(shortNodeKey, h.value)
				h.stack = append(h.stack, stackItem{
					ref:          rlpNodeFromRLP(rlpData),
					rootIsBranch: false,
				})
			} else {
				// Cached branch-root reference (raw RLP or rlp(hash)).
				refCopy := make([]byte, len(h.value))
				copy(refCopy, h.value)
				h.stack = append(h.stack, stackItem{
					ref:          refCopy,
					rootIsBranch: true,
				})

				if h.childNodeStored {
					h.treeMasks[current.Len()-1] |= 1 << current.At(current.Len()-1)
				}

				buildExtensions = true
			}
		}

		if buildExtensions && shortNodeKey.Len() > 0 {
			h.updateMasks(current, lenFrom)
			// Pop the last item and wrap it in an extension node
			stackLast := h.stack[len(h.stack)-1].ref
			h.stack = h.stack[:len(h.stack)-1]
			rlpData := rlpEncodeExtensionNode(shortNodeKey, stackLast)
			h.stack = append(h.stack, stackItem{
				ref:          rlpNodeFromRLP(rlpData),
				rootIsBranch: false,
			})
			h.resizeMasks(lenFrom)
		}

		if precedingLen <= commonPrefixLen && succeeding.Len() > 0 {
			return
		}

		// Insert branch nodes
		if succeeding.Len() > 0 || precedingExists {
			children := h.pushBranchNode(current, length)
			h.storeBranchNode(current, length, children)
		}

		// Shrink masks
		h.stateMasks = h.stateMasks[:length]
		h.resizeMasks(length)

		if precedingLen == 0 {
			return
		}

		current = current.Prefix(precedingLen)

		// Pop trailing zero masks
		for len(h.stateMasks) > 0 && h.stateMasks[len(h.stateMasks)-1] == 0 {
			h.stateMasks = h.stateMasks[:len(h.stateMasks)-1]
		}

		buildExtensions = true
	}
}

// pushBranchNode builds a branch node from the stack and state mask at the given level.
func (h *HashBuilder) pushBranchNode(current Nibbles, length int) [][]byte {
	stateMask := h.stateMasks[length]
	hashMask := h.hashMasks[length]

	// Count children (set bits in state mask)
	childCount := popcount16(stateMask)
	firstChildIdx := len(h.stack) - childCount

	// Collect child hashes if updates are enabled.
	// Try to extract hash from ALL children (not just those with hashMask set).
	// This ensures fresh trie computations also produce storable branch nodes.
	var children [][]byte
	if h.updates != nil {
		childIdx := firstChildIdx
		for nibble := 0; nibble < 16; nibble++ {
			if stateMask&(1<<nibble) != 0 {
				if h.stack[childIdx].rootIsBranch {
					ref := make([]byte, len(h.stack[childIdx].ref))
					copy(ref, h.stack[childIdx].ref)
					children = append(children, ref)
					// Only branch-root children are safe opaque replay boundaries.
					h.hashMasks[length] |= 1 << nibble
				}
				childIdx++
			}
		}
	}
	_ = hashMask // was used before; now hashes are collected for all children

	// RLP-encode the branch node from the stack
	rlpData := rlpEncodeBranchNodeFromStack(h.stack[firstChildIdx:], stateMask)
	rlpNode := rlpNodeFromRLP(rlpData)

	// Pop children from the stack
	h.stack = h.stack[:firstChildIdx]
	h.stack = append(h.stack, stackItem{
		ref:          rlpNode,
		rootIsBranch: true,
	})

	return children
}

// storeBranchNode records updates to persist branch nodes to DB.
func (h *HashBuilder) storeBranchNode(current Nibbles, length int, children [][]byte) {
	if length > 0 {
		parentIndex := length - 1
		h.hashMasks[parentIndex] |= 1 << current.At(parentIndex)
	}

	storeInDBTrie := h.treeMasks[length] != 0 || h.hashMasks[length] != 0
	if storeInDBTrie {
		if length > 0 {
			parentIndex := length - 1
			h.treeMasks[parentIndex] |= 1 << current.At(parentIndex)
		}

		if h.updates != nil {
			prefix := current.Prefix(length)
			packed := string(prefix.Pack())
			var rootHash *[32]byte
			if length == 0 {
				r := h.currentRoot()
				rootHash = &r
			}
			h.updates[packed] = &BranchNodeCompact{
				StateMask: h.stateMasks[length],
				TreeMask:  h.treeMasks[length],
				RefMask:   h.hashMasks[length],
				Refs:      children,
				RootHash:  rootHash,
			}
		}
	}
}

func (h *HashBuilder) updateMasks(current Nibbles, lenFrom int) {
	if lenFrom > 0 {
		flag := uint16(1) << current.At(lenFrom-1)
		h.hashMasks[lenFrom-1] &^= flag

		if h.treeMasks[current.Len()-1] != 0 {
			h.treeMasks[lenFrom-1] |= flag
		}
	}
}

func (h *HashBuilder) resizeMasks(newLen int) {
	for len(h.treeMasks) < newLen {
		h.treeMasks = append(h.treeMasks, 0)
	}
	h.treeMasks = h.treeMasks[:newLen]
	for len(h.hashMasks) < newLen {
		h.hashMasks = append(h.hashMasks, 0)
	}
	h.hashMasks = h.hashMasks[:newLen]
}

// --- RLP encoding helpers ---

// compactEncode converts nibbles to hex-prefix (compact) encoding.
// isLeaf: true for leaf nodes, false for extension nodes.
func compactEncode(n Nibbles, isLeaf bool) []byte {
	length := n.Len()
	odd := length%2 != 0
	encodedLen := length/2 + 1
	result := make([]byte, encodedLen)

	var flag byte
	if isLeaf {
		flag = 0x20
	}

	if odd {
		// Odd: first byte = flag|0x10 + first nibble
		result[0] = flag | 0x10 | n.At(0)
		for i := 1; i < length; i++ {
			byteIdx := (i + 1) / 2
			if i%2 == 1 {
				result[byteIdx] = n.At(i) << 4
			} else {
				result[byteIdx] |= n.At(i)
			}
		}
	} else {
		// Even: first byte = flag
		result[0] = flag
		for i := 0; i < length; i++ {
			byteIdx := i/2 + 1
			if i%2 == 0 {
				result[byteIdx] = n.At(i) << 4
			} else {
				result[byteIdx] |= n.At(i)
			}
		}
	}
	return result
}

// rlpEncodeLeafNode encodes a leaf node: list[compact_path, value]
func rlpEncodeLeafNode(path Nibbles, value []byte) []byte {
	compact := compactEncode(path, true)
	return rlpEncodeShortNode(compact, value)
}

// rlpEncodeExtensionNode encodes an extension node: list[compact_path, child]
// child is already RLP-encoded (either raw RLP or rlp(hash)).
func rlpEncodeExtensionNode(path Nibbles, child []byte) []byte {
	compact := compactEncode(path, false)
	return rlpEncodeShortNodeRaw(compact, child)
}

// rlpEncodeShortNode encodes a 2-element list [key_bytes, value_bytes]
// where both key and value are treated as byte strings.
func rlpEncodeShortNode(key, value []byte) []byte {
	keyEnc := rlpEncodeString(key)
	valEnc := rlpEncodeString(value)
	payload := append(keyEnc, valEnc...)
	return rlpEncodeList(payload)
}

// rlpEncodeShortNodeRaw encodes a 2-element list [key_bytes, raw_rlp]
// where key is a byte string and child is already RLP-encoded.
func rlpEncodeShortNodeRaw(key, child []byte) []byte {
	keyEnc := rlpEncodeString(key)
	payload := append(keyEnc, child...)
	return rlpEncodeList(payload)
}

// rlpEncodeBranchNodeFromStack encodes a branch node from the stack.
// stack contains the children in order of their set bits in stateMask.
// The branch node is: list[child0, child1, ..., child15, value]
// where empty children are encoded as 0x80 (empty string).
func rlpEncodeBranchNodeFromStack(children []stackItem, stateMask uint16) []byte {
	var payload []byte
	childIdx := 0
	for nibble := 0; nibble < 16; nibble++ {
		if stateMask&(1<<nibble) != 0 {
			// This child exists; its RLP is already encoded on the stack
			payload = append(payload, children[childIdx].ref...)
			childIdx++
		} else {
			// Empty child = 0x80
			payload = append(payload, rlp.EmptyString...)
		}
	}
	// 17th element: value (always empty for our MPT)
	payload = append(payload, rlp.EmptyString...)
	return rlpEncodeList(payload)
}

// rlpEncodeString encodes a byte slice as an RLP string.
func rlpEncodeString(b []byte) []byte {
	if len(b) == 1 && b[0] < 0x80 {
		return []byte{b[0]}
	}
	if len(b) < 56 {
		result := make([]byte, 1+len(b))
		result[0] = 0x80 + byte(len(b))
		copy(result[1:], b)
		return result
	}
	// Long string
	lenBytes := encodeUint(uint64(len(b)))
	result := make([]byte, 1+len(lenBytes)+len(b))
	result[0] = 0xb7 + byte(len(lenBytes))
	copy(result[1:], lenBytes)
	copy(result[1+len(lenBytes):], b)
	return result
}

// rlpEncodeList wraps payload as an RLP list.
func rlpEncodeList(payload []byte) []byte {
	if len(payload) < 56 {
		result := make([]byte, 1+len(payload))
		result[0] = 0xc0 + byte(len(payload))
		copy(result[1:], payload)
		return result
	}
	// Long list
	lenBytes := encodeUint(uint64(len(payload)))
	result := make([]byte, 1+len(lenBytes)+len(payload))
	result[0] = 0xf7 + byte(len(lenBytes))
	copy(result[1:], lenBytes)
	copy(result[1+len(lenBytes):], payload)
	return result
}

// encodeUint encodes a uint as big-endian bytes with no leading zeros.
func encodeUint(n uint64) []byte {
	if n == 0 {
		return nil
	}
	var buf [8]byte
	i := 7
	for n > 0 {
		buf[i] = byte(n)
		n >>= 8
		i--
	}
	return buf[i+1:]
}

// wordRLP returns the RLP encoding of a 32-byte hash: 0xa0 + hash.
func wordRLP(hash [32]byte) []byte {
	result := make([]byte, 33)
	result[0] = 0xa0
	copy(result[1:], hash[:])
	return result
}

// rlpNodeFromRLP returns the RLP-encoded node if < 32 bytes, or rlp(keccak256(node)) otherwise.
func rlpNodeFromRLP(rlpData []byte) []byte {
	if len(rlpData) < 32 {
		cp := make([]byte, len(rlpData))
		copy(cp, rlpData)
		return cp
	}
	hash := crypto.Keccak256Hash(rlpData)
	return wordRLP(hash)
}

// rlpNodeAsHash checks if an RLP node is a 33-byte encoded hash (0xa0 + 32 bytes)
// and returns the hash if so.
func rlpNodeAsHash(node []byte) (hash [32]byte, ok bool) {
	if len(node) == 33 && node[0] == 0xa0 {
		copy(hash[:], node[1:])
		return hash, true
	}
	return hash, false
}

// popcount16 counts set bits in a uint16.
func popcount16(x uint16) int {
	count := 0
	for x != 0 {
		count++
		x &= x - 1
	}
	return count
}
