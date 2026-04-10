package trie

import (
	"github.com/ava-labs/libevm/crypto"
	"github.com/erigontech/mdbx-go/mdbx"
)

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
// unchanged subtrees, or descended nodes for changed subtrees). The state
// cursor yields leaf entries (actual account/storage values). The merge
// interleaves them by nibble path order.
type NodeIter struct {
	walker      *TrieWalker
	stateCursor *mdbx.Cursor

	// statePrefix scopes the state cursor. For account trie this is nil.
	// For storage trie this is the 32-byte keccak(address) prefix.
	statePrefix []byte

	// Buffered elements from each source.
	walkerElem *TrieElement
	walkerDone bool
	stateElem  *TrieElement
	stateDone  bool
	stateStarted bool // whether we've done the initial seek on the state cursor

	done bool
}

// NewNodeIter creates a node iterator merging trie nodes and state entries.
// statePrefix scopes the state cursor (nil for account trie, keccak(address) for storage trie).
func NewNodeIter(walker *TrieWalker, stateCursor *mdbx.Cursor, statePrefix []byte) *NodeIter {
	n := &NodeIter{
		walker:      walker,
		stateCursor: stateCursor,
		statePrefix: statePrefix,
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

// advanceState fetches the next leaf element from the state cursor.
func (n *NodeIter) advanceState() {
	if n.stateDone {
		n.stateElem = nil
		return
	}

	for {
		var k, v []byte
		var err error

		if !n.stateStarted {
			// First call — seek to the beginning (or to the prefix).
			n.stateStarted = true
			if n.statePrefix != nil {
				k, v, err = n.stateCursor.Get(n.statePrefix, nil, mdbx.SetRange)
			} else {
				k, v, err = n.stateCursor.Get(nil, nil, mdbx.First)
			}
		} else {
			k, v, err = n.stateCursor.Get(nil, nil, mdbx.Next)
		}

		if err != nil {
			if mdbx.IsNotFound(err) {
				n.stateDone = true
				n.stateElem = nil
				return
			}
			// On error, stop iteration.
			n.stateDone = true
			n.stateElem = nil
			return
		}

		// Check prefix scope for storage tries.
		if n.statePrefix != nil {
			if len(k) < len(n.statePrefix) {
				n.stateDone = true
				n.stateElem = nil
				return
			}
			// If the key no longer starts with our prefix, we're done.
			prefixMatch := true
			for i := 0; i < len(n.statePrefix); i++ {
				if k[i] != n.statePrefix[i] {
					prefixMatch = false
					break
				}
			}
			if !prefixMatch {
				n.stateDone = true
				n.stateElem = nil
				return
			}
		}

		// Convert the DB key to a nibble path.
		// For accounts: key is keccak(address) [32B] → nibble path is FromHex(key)
		// For storage:  key is keccak(address) [32B] ++ keccak(slot) [32B]
		//               → nibble path is FromHex(keccak(slot)), i.e. the suffix after prefix
		var hashInput []byte
		if n.statePrefix != nil {
			// Storage: the key after the prefix is keccak(slot) already.
			hashInput = k[len(n.statePrefix):]
		} else {
			// Account: the key is keccak(address) already.
			hashInput = k
		}

		// The keys in AccountState/StorageState are already keccak hashes,
		// so the nibble path is just the hex expansion of the key bytes.
		nibblePath := FromHex(hashInput)

		// Copy value since the cursor may reuse the buffer.
		val := make([]byte, len(v))
		copy(val, v)

		n.stateElem = &TrieElement{
			Key:      nibblePath,
			IsBranch: false,
			Value:    val,
		}
		return
	}
}

// keccak256 computes the Keccak-256 hash of data and returns it as a 32-byte array.
func keccak256(data []byte) [32]byte {
	h := crypto.Keccak256(data)
	var result [32]byte
	copy(result[:], h)
	return result
}
