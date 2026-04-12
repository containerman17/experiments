package trie

import "sort"

// PrefixSetBuilder collects changed keys during block execution.
type PrefixSetBuilder struct {
	keys []Nibbles
}

// NewPrefixSetBuilder creates a new PrefixSetBuilder.
func NewPrefixSetBuilder() *PrefixSetBuilder {
	return &PrefixSetBuilder{}
}

// AddKey adds a changed key (as nibbles) to the builder.
func (b *PrefixSetBuilder) AddKey(key Nibbles) {
	b.keys = append(b.keys, key)
}

// Build sorts, deduplicates, and creates an immutable PrefixSet.
func (b *PrefixSetBuilder) Build() *PrefixSet {
	sort.Slice(b.keys, func(i, j int) bool {
		return b.keys[i].Compare(b.keys[j]) < 0
	})

	// Deduplicate
	if len(b.keys) > 1 {
		deduped := make([]Nibbles, 0, len(b.keys))
		deduped = append(deduped, b.keys[0])
		for i := 1; i < len(b.keys); i++ {
			if !b.keys[i].Equal(b.keys[i-1]) {
				deduped = append(deduped, b.keys[i])
			}
		}
		b.keys = deduped
	}

	return &PrefixSet{keys: b.keys}
}

// PrefixSet is an immutable, sorted set of nibble paths with cursor-based lookup.
type PrefixSet struct {
	keys  []Nibbles
	index int // cursor for sequential access
}

// Reset rewinds the sequential cursor so the prefix set can be scanned again
// from the beginning in a new ordered pass.
func (ps *PrefixSet) Reset() {
	ps.index = 0
}

// ContainsPrefix returns true if any key in the set starts with the given prefix.
// Uses sequential cursor optimization: exploits that calls come in sorted order
// during the trie walk, so we advance the cursor forward instead of binary searching
// from the beginning each time.
func (ps *PrefixSet) ContainsPrefix(prefix Nibbles) bool {
	if ps.index >= len(ps.keys) {
		return false
	}

	// Advance cursor past keys that are less than the prefix.
	// A key is "less than" the prefix when it cannot possibly start with the prefix.
	// We advance while: key < prefix AND key does not start with prefix.
	for ps.index < len(ps.keys) {
		cmp := ps.keys[ps.index].Compare(prefix)
		if cmp >= 0 {
			// key >= prefix, stop advancing
			break
		}
		// key < prefix: but check if key is a prefix of prefix (shorter key that prefix extends)
		// No — we only care if key starts with prefix, not the other way around.
		// Actually: if the key starts with prefix, that means prefix is a prefix of key,
		// which can't happen if key < prefix and key is shorter... but if key is shorter
		// and is a prefix of prefix, then key < prefix is still true.
		// We need to check: does key start with prefix? Only if len(key) >= len(prefix).
		if ps.keys[ps.index].HasPrefix(prefix) {
			return true
		}
		ps.index++
	}

	if ps.index >= len(ps.keys) {
		return false
	}

	// Check if the key at the current position starts with the prefix.
	return ps.keys[ps.index].HasPrefix(prefix)
}

// ContainsPrefixUnordered returns true if any key in the set starts with the
// given prefix, without assuming anything about call order.
func (ps *PrefixSet) ContainsPrefixUnordered(prefix Nibbles) bool {
	idx := sort.Search(len(ps.keys), func(i int) bool {
		return ps.keys[i].Compare(prefix) >= 0
	})
	if idx >= len(ps.keys) {
		return false
	}
	return ps.keys[idx].HasPrefix(prefix)
}
