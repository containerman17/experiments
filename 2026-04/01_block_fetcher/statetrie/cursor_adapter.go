package statetrie

import (
	"bytes"

	"github.com/erigontech/mdbx-go/mdbx"
)

// PrefixedTrieCursor adapts an MDBX cursor for use with trie.TrieWalker when
// keys in the table are prefixed (e.g., StorageTrie keys are keccak(address) || packedNibblePath).
//
// It transparently:
//   - Prepends the prefix to seek keys
//   - Strips the prefix from returned keys
//   - Stops iteration when keys no longer match the prefix
type PrefixedTrieCursor struct {
	cursor  *mdbx.Cursor
	prefix  []byte
	started bool
	done    bool
}

// NewPrefixedTrieCursor creates a cursor adapter that scopes iteration to keys
// beginning with prefix and strips that prefix from returned keys.
func NewPrefixedTrieCursor(cursor *mdbx.Cursor, prefix []byte) *PrefixedTrieCursor {
	return &PrefixedTrieCursor{
		cursor: cursor,
		prefix: prefix,
	}
}

// Get implements trie.TrieCursor. It intercepts cursor operations to handle
// prefix scoping:
//   - mdbx.First: seeks to the first key with the prefix
//   - mdbx.SetRange: prepends the prefix to the seek key
//   - mdbx.Next: advances and stops if past the prefix scope
func (c *PrefixedTrieCursor) Get(key, val []byte, op uint) ([]byte, []byte, error) {
	if c.done {
		return nil, nil, mdbx.NotFound
	}

	var k, v []byte
	var err error

	switch op {
	case mdbx.First:
		// Seek to the start of our prefix range.
		k, v, err = c.cursor.Get(c.prefix, nil, mdbx.SetRange)
		c.started = true

	case mdbx.SetRange:
		// Prepend prefix to the seek key.
		fullKey := make([]byte, len(c.prefix)+len(key))
		copy(fullKey, c.prefix)
		copy(fullKey[len(c.prefix):], key)
		k, v, err = c.cursor.Get(fullKey, nil, mdbx.SetRange)
		c.started = true

	case mdbx.Next:
		k, v, err = c.cursor.Get(nil, nil, mdbx.Next)

	default:
		k, v, err = c.cursor.Get(key, val, op)
	}

	if err != nil {
		if mdbx.IsNotFound(err) {
			c.done = true
		}
		return nil, nil, err
	}

	// Check if we're still within the prefix scope.
	if len(k) < len(c.prefix) || !bytes.HasPrefix(k, c.prefix) {
		c.done = true
		return nil, nil, mdbx.NotFound
	}

	// Strip the prefix from the returned key. Copy to avoid MDBX invalidation.
	suffix := k[len(c.prefix):]
	keyCopy := make([]byte, len(suffix))
	copy(keyCopy, suffix)

	valCopy := make([]byte, len(v))
	copy(valCopy, v)

	return keyCopy, valCopy, nil
}

// Close closes the underlying cursor.
func (c *PrefixedTrieCursor) Close() {
	c.cursor.Close()
}
