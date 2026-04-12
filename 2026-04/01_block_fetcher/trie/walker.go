package trie

import (
	"math/bits"

	"github.com/erigontech/mdbx-go/mdbx"
)

// TrieCursor is an interface abstracting MDBX cursor operations for the TrieWalker.
// This allows wrapping a raw *mdbx.Cursor with prefix-stripping adapters
// (e.g., for per-address scoped StorageTrie tables).
type TrieCursor interface {
	Get(key, val []byte, op uint) ([]byte, []byte, error)
	Close()
}

// TrieWalker walks trie nodes from MDBX, skipping unchanged subtrees.
//
// It reads BranchNodeCompact entries from a trie cursor (AccountTrie or StorageTrie)
// and uses a PrefixSet to decide which branches need re-examination (changed)
// versus which can be skipped (returning their cached hash).
type TrieWalker struct {
	cursor    TrieCursor
	prefixSet *PrefixSet

	// Stack of branch nodes being traversed. Each frame represents a node
	// we have descended into and are iterating children of.
	stack []walkerFrame

	// Whether we have started iteration.
	started bool
	// Whether iteration is complete.
	done bool

	// Buffered next result (set by advance, consumed by caller).
	nextKey  Nibbles
	nextNode *BranchNodeCompact
	nextRef  []byte
	hasNext  bool
}

type walkerFrame struct {
	key      Nibbles            // nibble path of this node
	node     *BranchNodeCompact // the decoded branch node
	childIdx int                // next child nibble to examine (0-16; 16 means done)
}

// NewTrieWalker creates a walker over a trie table.
// cursor can be a raw *mdbx.Cursor or any TrieCursor implementation (e.g., PrefixedTrieCursor).
func NewTrieWalker(cursor TrieCursor, prefixSet *PrefixSet) *TrieWalker {
	return &TrieWalker{
		cursor:    cursor,
		prefixSet: prefixSet,
	}
}

// Advance moves to the next trie node.
// Returns:
//   - key: nibble path of the node
//   - node: the branch node (non-nil if this branch was descended into and needs re-hashing)
//   - hash: cached hash to use (non-zero if we're skipping this subtree)
//   - done: true when iteration is complete
func (w *TrieWalker) Advance() (key Nibbles, node *BranchNodeCompact, hash [32]byte, childrenInTrie bool, done bool) {
	key, ref, node, childrenInTrie, done := w.AdvanceRef()
	if len(ref) == 33 && ref[0] == 0xa0 {
		copy(hash[:], ref[1:])
	}
	return key, node, hash, childrenInTrie, done
}

// AdvanceRef moves to the next trie node, returning the exact cached child reference
// bytes for skipped subtrees (raw RLP or rlp(hash)).
func (w *TrieWalker) AdvanceRef() (key Nibbles, ref []byte, node *BranchNodeCompact, childrenInTrie bool, done bool) {
	if w.done {
		return Nibbles{}, nil, nil, false, true
	}

	if !w.started {
		w.started = true
		// Seek to the very first trie node.
		if err := w.seekFirst(); err != nil {
			w.done = true
			return Nibbles{}, nil, nil, false, true
		}
		if w.done {
			return Nibbles{}, nil, nil, false, true
		}
	}

	// Process the stack to find the next element to yield.
	for len(w.stack) > 0 {
		frame := &w.stack[len(w.stack)-1]

		// Find the next child with state in this node.
		descended := false
		for frame.childIdx < 16 {
			nibble := frame.childIdx
			frame.childIdx++

			if frame.node.StateMask&(1<<nibble) == 0 {
				// This child doesn't exist in state, skip.
				continue
			}

			childPath := frame.key.Append(byte(nibble))

			// Check if this child's subtree has changes.
			if w.prefixSet.ContainsPrefix(childPath) {
				// This subtree has changes — we need to descend.

				// If this child has a subtree stored in the DB (tree_mask bit set),
				// seek to it and descend.
				if frame.node.TreeMask&(1<<nibble) != 0 {
					childNode, err := w.seekNode(childPath)
					if err == nil && childNode != nil {
						w.stack = append(w.stack, walkerFrame{
							key:      childPath,
							node:     childNode,
							childIdx: 0,
						})
						descended = true
						break
					}
				}
				continue
			}

			// This subtree is unchanged — yield the cached hash.
			if frame.node.RefMask&(1<<nibble) != 0 {
				ref := w.refForChild(frame.node, nibble)
				return childPath, ref, nil, frame.node.TreeMask&(1<<nibble) != 0, false
			}

			// Child exists in state but has no hash cached — this shouldn't normally
			// happen for unchanged subtrees. Skip it.
		}

		if descended {
			// We pushed a child frame — continue the outer loop to process it.
			continue
		}

		// All children of this node are processed. Pop the frame.
		w.stack = w.stack[:len(w.stack)-1]
	}

	w.done = true
	return Nibbles{}, nil, nil, false, true
}

// seekFirst seeks to the first trie node and pushes it onto the stack.
func (w *TrieWalker) seekFirst() error {
	k, v, err := w.cursor.Get(nil, nil, mdbx.First)
	if err != nil {
		if mdbx.IsNotFound(err) {
			w.done = true
			return nil
		}
		return err
	}

	node, err := DecodeBranchNode(v)
	if err != nil {
		w.done = true
		return err
	}

	key := Unpack(k)
	w.stack = append(w.stack, walkerFrame{
		key:      key,
		node:     node,
		childIdx: 0,
	})
	return nil
}

// seekNode seeks to a trie node at the given nibble path.
// Returns nil if no node exists at or after this path that matches.
func (w *TrieWalker) seekNode(path Nibbles) (*BranchNodeCompact, error) {
	packed := path.Pack()
	k, v, err := w.cursor.Get(packed, nil, mdbx.SetRange)
	if err != nil {
		if mdbx.IsNotFound(err) {
			return nil, nil
		}
		return nil, err
	}

	// Verify the found key actually matches our path (SetRange finds >= key).
	foundPath := Unpack(k)
	if !foundPath.Equal(path) {
		return nil, nil
	}

	node, err := DecodeBranchNode(v)
	if err != nil {
		return nil, err
	}

	return node, nil
}

// refForChild returns the cached child reference for the given child nibble.
func (w *TrieWalker) refForChild(node *BranchNodeCompact, childNibble int) []byte {
	if node.RefMask&(1<<childNibble) == 0 {
		return nil
	}
	mask := node.RefMask & ((1 << childNibble) - 1)
	idx := bits.OnesCount16(mask)
	if idx < len(node.Refs) {
		ref := make([]byte, len(node.Refs[idx]))
		copy(ref, node.Refs[idx])
		return ref
	}
	return nil
}
