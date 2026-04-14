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

	// SeekTo positions the cursor at the first entry >= the given key.
	// The next call to Next() will return that entry.
	// key is raw bytes (not nibbles). If key is nil, this is a no-op.
	SeekTo(key []byte) error
}

// MDBXLeafSource wraps an MDBX cursor as a LeafSource.
// It iterates entries starting from prefix, stopping when entries
// no longer match the prefix.
type MDBXLeafSource struct {
	cursor      *mdbx.Cursor
	prefix      []byte
	started     bool
	done        bool
	seekTarget  []byte
	seekPending bool
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

	if s.seekPending {
		s.seekPending = false
		k, v, err = s.cursor.Get(s.seekTarget, nil, mdbx.SetRange)
	} else if !s.started {
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

// SeekTo positions the cursor so the next Next() returns the first entry >= key.
// key is raw bytes (without the prefix — prefix is prepended internally).
func (s *MDBXLeafSource) SeekTo(key []byte) error {
	if s.done || key == nil {
		return nil
	}
	if s.prefix != nil {
		sk := make([]byte, len(s.prefix)+len(key))
		copy(sk, s.prefix)
		copy(sk[len(s.prefix):], key)
		s.seekTarget = sk
	} else {
		sk := make([]byte, len(key))
		copy(sk, key)
		s.seekTarget = sk
	}
	s.seekPending = true
	s.started = true
	return nil
}

// TrieElement represents either a branch node or a leaf in the merged iteration.
type TrieElement struct {
	// Key is the nibble path of this element.
	Key Nibbles

	// IsBranch is true for branch nodes (from the trie walker).
	IsBranch bool

	// For branches that are skipped (unchanged subtree):
	Ref []byte

	// For branches that are descended into:
	Node *BranchNodeCompact

	// ChildNodeStored indicates whether this cached child has a stored branch
	// node in the DB that the walker can descend into on a future update.
	ChildNodeStored bool

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
				n.seekStatePast(elem.Key)
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

	key, ref, node, childrenInTrie, done := n.walker.AdvanceRef()
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
			elem.Node = node
			elem.ChildNodeStored = true
		} else {
			// Skipped branch — use the cached hash.
			// Preserve whether the skipped child has a stored branch node so
			// the HashBuilder can maintain TreeMask separately from cacheability.
			elem.Ref = ref
			elem.ChildNodeStored = childrenInTrie
		}

	n.walkerElem = elem
}

// seekStatePast seeks the state cursor past all entries under the given nibble prefix.
// This converts O(subtree_size) sequential Next() calls into one cursor seek.
func (n *NodeIter) seekStatePast(prefix Nibbles) {
	if n.stateDone {
		return
	}
	// Compute the first raw key that is NOT under this prefix.
	// Nibble prefix "03a5" → raw bytes [0x03, 0xa5]. The successor is found
	// by incrementing the last nibble. For odd-length prefixes, we increment
	// the high nibble of the last byte.
	afterKey := prefix.SuccessorRawKey()
	if afterKey == nil {
		// Prefix covers entire keyspace — exhaust the source.
		n.stateDone = true
		n.stateElem = nil
		return
	}
	if err := n.leafSource.SeekTo(afterKey); err != nil {
		n.stateDone = true
		n.stateElem = nil
		return
	}
	n.advanceState()
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
