package store

import (
	"bytes"
	"encoding/binary"
	"fmt"

	"github.com/RoaringBitmap/roaring/v2/roaring64"
	"github.com/erigontech/mdbx-go/mdbx"
	"github.com/pierrec/lz4/v4"
)

type Change struct {
	KeyID    uint64
	OldValue []byte
}

func encodeChangeset(changes []Change) []byte {
	size := 4
	for _, c := range changes {
		size += 8 + 2 + len(c.OldValue)
	}
	buf := make([]byte, size)
	binary.BigEndian.PutUint32(buf[0:4], uint32(len(changes)))
	off := 4
	for _, c := range changes {
		binary.BigEndian.PutUint64(buf[off:off+8], c.KeyID)
		off += 8
		binary.BigEndian.PutUint16(buf[off:off+2], uint16(len(c.OldValue)))
		off += 2
		copy(buf[off:], c.OldValue)
		off += len(c.OldValue)
	}
	return buf
}

func decodeChangeset(data []byte) ([]Change, error) {
	if len(data) < 4 {
		return nil, fmt.Errorf("changeset too short")
	}
	n := binary.BigEndian.Uint32(data[0:4])
	changes := make([]Change, n)
	off := 4
	for i := range n {
		if off+10 > len(data) {
			return nil, fmt.Errorf("changeset truncated at change %d", i)
		}
		keyID := binary.BigEndian.Uint64(data[off : off+8])
		off += 8
		vLen := int(binary.BigEndian.Uint16(data[off : off+2]))
		off += 2
		if off+vLen > len(data) {
			return nil, fmt.Errorf("changeset truncated at value %d", i)
		}
		val := make([]byte, vLen)
		copy(val, data[off:off+vLen])
		off += vLen
		changes[i] = Change{KeyID: keyID, OldValue: val}
	}
	return changes, nil
}

// Reusable buffers for WriteChangeset to avoid per-call allocations.
// Only safe for single-threaded use (which is the case — one RW tx at a time).
var (
	lz4HashTable = make([]int, 1<<16)
	lz4CompBuf   []byte
)

func WriteChangeset(tx *mdbx.Txn, db *DB, blockNum uint64, changes []Change) error {
	raw := encodeChangeset(changes)
	needed := lz4.CompressBlockBound(len(raw))
	if cap(lz4CompBuf) < needed {
		lz4CompBuf = make([]byte, needed)
	}
	buf := lz4CompBuf[:needed]
	// Clear hash table (reuse the allocation)
	for i := range lz4HashTable {
		lz4HashTable[i] = 0
	}
	n, _ := lz4.CompressBlock(raw, buf, lz4HashTable)
	key := BlockKey(blockNum)
	if n == 0 {
		out := make([]byte, 1+len(raw))
		out[0] = 0
		copy(out[1:], raw)
		return tx.Put(db.Changesets, key[:], out, 0)
	}
	out := make([]byte, 1+n)
	out[0] = 1
	copy(out[1:], buf[:n])
	return tx.Put(db.Changesets, key[:], out, 0)
}

func ReadChangeset(tx *mdbx.Txn, db *DB, blockNum uint64) ([]Change, error) {
	key := BlockKey(blockNum)
	data, err := tx.Get(db.Changesets, key[:])
	if err != nil {
		return nil, err
	}
	var raw []byte
	if len(data) == 0 {
		return nil, fmt.Errorf("empty changeset")
	}
	if data[0] == 0 {
		raw = make([]byte, len(data)-1)
		copy(raw, data[1:])
	} else {
		compressed := data[1:]
		for size := len(compressed) * 4; size <= 32*1024*1024; size *= 2 {
			buf := make([]byte, size)
			n, err := lz4.UncompressBlock(compressed, buf)
			if err == nil {
				raw = buf[:n]
				break
			}
		}
		if raw == nil {
			return nil, fmt.Errorf("lz4 decompress failed")
		}
	}
	return decodeChangeset(raw)
}

const maxShardSize = 2000

// Reusable bitmap and buffer for UpdateHistoryIndex.
// Single-threaded (one RW tx at a time).
var (
	histBitmap = roaring64.NewBitmap()
	histBuf    bytes.Buffer
	histKeyCopy [16]byte
	histValBuf  []byte
)

func UpdateHistoryIndex(tx *mdbx.Txn, db *DB, keyID uint64, blockNum uint64) error {
	cursor, err := tx.OpenCursor(db.HistoryIndex)
	if err != nil {
		return err
	}
	defer cursor.Close()

	seekKey := HistoryKey(keyID, blockNum)
	prefix := KeyIDBytes(keyID)

	kRaw, v, err := cursor.Get(seekKey[:], nil, mdbx.SetRange)
	if err != nil && !mdbx.IsNotFound(err) {
		return err
	}

	// Copy cursor-returned key and value since they point to MDBX internal
	// memory-mapped pages which may be invalidated by subsequent tx.Put/Del calls.
	var k []byte
	if err == nil {
		copy(histKeyCopy[:], kRaw)
		k = histKeyCopy[:len(kRaw)]
		if cap(histValBuf) < len(v) {
			histValBuf = make([]byte, len(v))
		}
		histValBuf = histValBuf[:len(v)]
		copy(histValBuf, v)
	}

	if err == nil && bytes.HasPrefix(k, prefix[:]) {
		// Existing shard found — reuse bitmap
		histBitmap.Clear()
		if _, err := histBitmap.ReadFrom(bytes.NewReader(histValBuf)); err != nil {
			return fmt.Errorf("decode bitmap: %w", err)
		}
		histBitmap.Add(blockNum)

		if histBitmap.GetCardinality() > maxShardSize {
			// Seal current shard with actual max as key
			maxBlock := histBitmap.Maximum()
			sealKey := HistoryKey(keyID, maxBlock)
			histBuf.Reset()
			if _, err := histBitmap.WriteTo(&histBuf); err != nil {
				return err
			}
			if err := tx.Put(db.HistoryIndex, sealKey[:], histBuf.Bytes(), 0); err != nil {
				return err
			}
			if !bytes.Equal(k, sealKey[:]) {
				if err := tx.Del(db.HistoryIndex, k, nil); err != nil {
					return err
				}
			}
			// Create new sentinel with just blockNum
			histBitmap.Clear()
			histBitmap.Add(blockNum)
			histBuf.Reset()
			if _, err := histBitmap.WriteTo(&histBuf); err != nil {
				return err
			}
			sentinel := HistoryKey(keyID, 0xFFFFFFFFFFFFFFFF)
			return tx.Put(db.HistoryIndex, sentinel[:], histBuf.Bytes(), 0)
		}

		// Write updated bitmap back to same key
		histBuf.Reset()
		if _, err := histBitmap.WriteTo(&histBuf); err != nil {
			return err
		}
		return tx.Put(db.HistoryIndex, k, histBuf.Bytes(), 0)
	}

	// No shard for this keyID yet — create sentinel
	histBitmap.Clear()
	histBitmap.Add(blockNum)
	histBuf.Reset()
	if _, err := histBitmap.WriteTo(&histBuf); err != nil {
		return err
	}
	sentinel := HistoryKey(keyID, 0xFFFFFFFFFFFFFFFF)
	return tx.Put(db.HistoryIndex, sentinel[:], histBuf.Bytes(), 0)
}

func LookupHistoricalBlock(tx *mdbx.Txn, db *DB, keyID uint64, blockNum uint64) (uint64, bool, error) {
	cursor, err := tx.OpenCursor(db.HistoryIndex)
	if err != nil {
		return 0, false, err
	}
	defer cursor.Close()

	seekKey := HistoryKey(keyID, blockNum)
	prefix := KeyIDBytes(keyID)

	k, v, err := cursor.Get(seekKey[:], nil, mdbx.SetRange)
	if err != nil {
		if mdbx.IsNotFound(err) {
			return 0, false, nil
		}
		return 0, false, err
	}

	if !bytes.HasPrefix(k, prefix[:]) {
		return 0, false, nil
	}

	bm := roaring64.NewBitmap()
	if _, err := bm.ReadFrom(bytes.NewReader(v)); err != nil {
		return 0, false, fmt.Errorf("decode bitmap: %w", err)
	}

	it := bm.Iterator()
	it.AdvanceIfNeeded(blockNum)
	if it.HasNext() {
		return it.Next(), true, nil
	}

	return 0, false, nil
}

// LookupHistorical returns the value of a key at a given block number.
// It finds the earliest changeset AFTER blockNum that touched this key,
// then returns the old value from that changeset.
// If no changeset after blockNum touched this key, the current flat state value is still valid.
// lookupHistoricalRaw returns the raw old value for a key at a given block number.
// isAccount distinguishes account vs storage lookups for the fallback to current state.
func lookupHistoricalRaw(tx *mdbx.Txn, db *DB, addr [20]byte, slot [32]byte, blockNum uint64, isAccount bool) ([]byte, error) {
	keyID, found, err := GetKeyID(tx, db, addr, slot)
	if err != nil {
		return nil, fmt.Errorf("GetKeyID: %w", err)
	}
	if !found {
		// Key was never modified — return current flat state value (or nil).
		return lookupCurrentFlatValue(tx, db, addr, slot, isAccount)
	}

	// Find the FIRST block that ever changed this key (to handle pre-history lookups).
	firstChange, hasFirst, err := LookupHistoricalBlock(tx, db, keyID, 0)
	if err != nil {
		return nil, fmt.Errorf("LookupHistoricalBlock first: %w", err)
	}
	if hasFirst && blockNum < firstChange {
		// The queried block is BEFORE this key was ever modified.
		// Read the oldValue from the first changeset — that's the genesis/pre-creation value.
		changes, err := ReadChangeset(tx, db, firstChange)
		if err != nil {
			return nil, fmt.Errorf("ReadChangeset at first block %d: %w", firstChange, err)
		}
		for _, c := range changes {
			if c.KeyID == keyID {
				return c.OldValue, nil // genesis value (often empty = key didn't exist)
			}
		}
		return nil, nil // key not found in changeset = didn't exist
	}

	// Find the first block strictly AFTER blockNum that changed this key.
	changeBlock, hasChange, err := LookupHistoricalBlock(tx, db, keyID, blockNum+1)
	if err != nil {
		return nil, fmt.Errorf("LookupHistoricalBlock: %w", err)
	}

	if !hasChange {
		// No block after blockNum changed this key — current flat state is the value.
		return lookupCurrentFlatValue(tx, db, addr, slot, isAccount)
	}

	// Read the changeset at changeBlock to get the old value (= value at blockNum).
	changes, err := ReadChangeset(tx, db, changeBlock)
	if err != nil {
		return nil, fmt.Errorf("ReadChangeset at block %d: %w", changeBlock, err)
	}

	for _, c := range changes {
		if c.KeyID == keyID {
			return c.OldValue, nil
		}
	}

	return nil, fmt.Errorf("keyID %d listed in history at block %d but not found in changeset", keyID, changeBlock)
}

// lookupCurrentFlatValue returns the current flat state value for a given (addr, slot).
// For account-level lookups (slot == zero), returns the encoded account bytes.
// For storage lookups, returns the 32-byte storage value.
func lookupCurrentFlatValue(tx *mdbx.Txn, db *DB, addr [20]byte, slot [32]byte, isAccount bool) ([]byte, error) {
	if isAccount {
		acct, err := GetAccount(tx, db, addr)
		if err != nil {
			return nil, err
		}
		if acct == nil {
			return nil, nil
		}
		return EncodeAccountBytes(acct), nil
	}
	// Storage lookup
	val, err := GetStorage(tx, db, addr, slot)
	if err != nil {
		return nil, err
	}
	var zeroVal [32]byte
	if val == zeroVal {
		return nil, nil
	}
	// Return trimmed bytes (matching changeset format)
	v := val[:]
	for len(v) > 1 && v[0] == 0 {
		v = v[1:]
	}
	return v, nil
}

// LookupHistoricalAccount returns the account state at a given block number.
func LookupHistoricalAccount(tx *mdbx.Txn, db *DB, addr [20]byte, blockNum uint64) (*Account, error) {
	data, err := lookupHistoricalRaw(tx, db, addr, AccountSentinelSlot, blockNum, true)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		return nil, nil
	}
	return DecodeAccount(data), nil
}

// LookupHistoricalStorage returns the storage value at a given block number.
func LookupHistoricalStorage(tx *mdbx.Txn, db *DB, addr [20]byte, slot [32]byte, blockNum uint64) ([32]byte, error) {
	data, err := lookupHistoricalRaw(tx, db, addr, slot, blockNum, false)
	if err != nil {
		return [32]byte{}, err
	}
	if len(data) == 0 {
		return [32]byte{}, nil
	}
	// Pad trimmed bytes back to 32 bytes, right-aligned.
	var result [32]byte
	if len(data) <= 32 {
		copy(result[32-len(data):], data)
	} else {
		copy(result[:], data[:32]) // shouldn't happen but safety
	}
	return result, nil
}
