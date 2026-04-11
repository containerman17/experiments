package trie

import (
	"bytes"

	"github.com/erigontech/mdbx-go/mdbx"
)

// LeafSource provides sorted leaf entries for the trie computation.
// Entries must be yielded in ascending key order (by the raw bytes of the key,
// which for hashed state tables means keccak-sorted order).
type LeafSource interface {
	// Next returns the next (key, value) pair.
	// Returns (nil, nil, nil) when exhausted.
	// key is the raw bytes from the DB (e.g., 32-byte keccak hash for accounts,
	// or the suffix after a prefix for storage).
	Next() (key []byte, value []byte, err error)
}

// MDBXLeafSource wraps an MDBX cursor as a LeafSource.
// It iterates entries starting from prefix, stopping when entries
// no longer match the prefix.
type MDBXLeafSource struct {
	cursor  *mdbx.Cursor
	prefix  []byte
	started bool
	done    bool
	// Pre-allocated key buffer — callers copy via FromHex before next call.
	keyBuf [32]byte
}

// NewMDBXLeafSource creates a LeafSource backed by an MDBX cursor.
// prefix scopes the iteration: for account trie this is nil (iterate all),
// for storage trie this is the 32-byte keccak(address) prefix.
// When prefix is set, returned keys have the prefix stripped (only the suffix is returned).
func NewMDBXLeafSource(cursor *mdbx.Cursor, prefix []byte) *MDBXLeafSource {
	return &MDBXLeafSource{
		cursor: cursor,
		prefix: prefix,
	}
}

// Next returns the next (key, value) pair from the MDBX cursor.
// Returns (nil, nil, nil) when exhausted or past the prefix scope.
func (s *MDBXLeafSource) Next() ([]byte, []byte, error) {
	if s.done {
		return nil, nil, nil
	}

	var k, v []byte
	var err error

	if !s.started {
		s.started = true
		if s.prefix != nil {
			k, v, err = s.cursor.Get(s.prefix, nil, mdbx.SetRange)
		} else {
			k, v, err = s.cursor.Get(nil, nil, mdbx.First)
		}
	} else {
		k, v, err = s.cursor.Get(nil, nil, mdbx.Next)
	}

	if err != nil {
		if mdbx.IsNotFound(err) {
			s.done = true
			return nil, nil, nil
		}
		s.done = true
		return nil, nil, err
	}

	// Check prefix scope.
	if s.prefix != nil {
		if len(k) < len(s.prefix) || !bytes.HasPrefix(k, s.prefix) {
			s.done = true
			return nil, nil, nil
		}
	}

	// Copy key and value from MDBX mmap'd memory into owned buffers.
	var keySrc []byte
	if s.prefix != nil {
		keySrc = k[len(s.prefix):]
	} else {
		keySrc = k
	}

	// Key: use fixed buffer (callers copy via FromHex before next call).
	var keyCopy []byte
	if len(keySrc) <= 32 {
		copy(s.keyBuf[:], keySrc)
		keyCopy = s.keyBuf[:len(keySrc)]
	} else {
		keyCopy = make([]byte, len(keySrc))
		copy(keyCopy, keySrc)
	}

	// Value: must allocate — callers may hold references across Next() calls.
	valCopy := make([]byte, len(v))
	copy(valCopy, v)

	return keyCopy, valCopy, nil
}

// TrieElement represents either a branch node or a leaf in the merged iteration.
type TrieElement struct {
	// Key is the nibble path of this element.
	Key Nibbles

	// IsBranch is true for branch nodes (from the trie walker).
	IsBranch bool

	// For branches that are skipped (unchanged subtree):
	Hash [32]byte

	// For branches that are descended into:
	Node *BranchNodeCompact

	// ChildrenInTrie indicates whether this branch's children are stored in the DB.
	ChildrenInTrie bool

	// For leaves:
	Value []byte
}

// NodeIter merges trie walker output with flat state entries, producing
// elements in sorted nibble order for the HashBuilder.
//
// The walker yields branch nodes from the trie DB (either cached hashes for
// unchanged subtrees, or descended nodes for changed subtrees). The leaf
// source yields leaf entries (actual account/storage values). The merge
// interleaves them by nibble path order.
type NodeIter struct {
	walker     *TrieWalker
	leafSource LeafSource

	// Buffered elements from each source.
	walkerElem *TrieElement
	walkerDone bool
	stateElem  *TrieElement
	stateDone  bool

	done bool
}

// NewNodeIter creates a node iterator merging trie nodes and leaf entries.
// leaves provides sorted leaf entries (use MDBXLeafSource for MDBX-backed iteration,
// or any other LeafSource implementation for merged/overlay sources).
func NewNodeIter(walker *TrieWalker, leaves LeafSource) *NodeIter {
	n := &NodeIter{
		walker:     walker,
		leafSource: leaves,
	}
	// Prime both sources.
	n.advanceWalker()
	n.advanceState()
	return n
}

// Next returns the next element in sorted nibble order.
// Returns nil when iteration is complete.
func (n *NodeIter) Next() (*TrieElement, error) {
	if n.done {
		return nil, nil
	}

	for {
		hasWalker := n.walkerElem != nil
		hasState := n.stateElem != nil

		if !hasWalker && !hasState {
			n.done = true
			return nil, nil
		}

		if hasWalker && !hasState {
			elem := n.walkerElem
			n.advanceWalker()
			return elem, nil
		}

		if !hasWalker && hasState {
			elem := n.stateElem
			n.advanceState()
			return elem, nil
		}

		// Both have elements — compare nibble paths.
		cmp := n.walkerElem.Key.Compare(n.stateElem.Key)

		if cmp < 0 {
			// Walker is behind — yield walker element.
			elem := n.walkerElem
			n.advanceWalker()

			// If this is a cached-hash branch (not descended into),
			// skip all state leaves that fall under this subtree.
			// They're covered by the branch's cached hash.
			if elem.IsBranch && elem.Node == nil {
				for n.stateElem != nil && n.stateElem.Key.HasPrefix(elem.Key) {
					n.advanceState()
				}
			}

			return elem, nil
		}

		if cmp > 0 {
			// State is behind — yield state leaf.
			elem := n.stateElem
			n.advanceState()
			return elem, nil
		}

		// Equal keys: state leaf takes precedence (it's the updated value).
		// Skip the walker element.
		n.advanceWalker()
		elem := n.stateElem
		n.advanceState()
		return elem, nil
	}
}

// advanceWalker fetches the next element from the trie walker.
func (n *NodeIter) advanceWalker() {
	if n.walkerDone {
		n.walkerElem = nil
		return
	}

	key, node, hash, done := n.walker.Advance()
	if done {
		n.walkerDone = true
		n.walkerElem = nil
		return
	}

	elem := &TrieElement{
		Key:      key,
		IsBranch: true,
	}

	if node != nil {
		// Descended branch node — the walker found it and we should
		// note it exists but the HashBuilder doesn't directly use it.
		// The children will be yielded individually by subsequent walker advances.
		// We still yield this as a branch element so the HashBuilder knows
		// about this level in the trie.
		elem.Node = node
		elem.ChildrenInTrie = true
	} else {
		// Skipped branch — use the cached hash.
		elem.Hash = hash
		elem.ChildrenInTrie = false
	}

	n.walkerElem = elem
}

// advanceState fetches the next leaf element from the leaf source.
func (n *NodeIter) advanceState() {
	if n.stateDone {
		n.stateElem = nil
		return
	}

	k, v, err := n.leafSource.Next()
	if err != nil {
		n.stateDone = true
		n.stateElem = nil
		return
	}
	if k == nil {
		// Exhausted.
		n.stateDone = true
		n.stateElem = nil
		return
	}

	// The keys from the LeafSource are already the raw bytes we need
	// (keccak hashes for hashed state). Convert to nibble path.
	nibblePath := FromHex(k)

	// Value is already copied by the LeafSource contract.
	n.stateElem = &TrieElement{
		Key:      nibblePath,
		IsBranch: false,
		Value:    v,
	}
}
