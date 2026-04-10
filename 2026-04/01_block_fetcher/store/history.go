package store

import (
	"bytes"
	"encoding/binary"
	"fmt"

	"github.com/RoaringBitmap/roaring/v2/roaring64"
	"github.com/erigontech/mdbx-go/mdbx"
	"github.com/klauspost/compress/zstd"
)

type Change struct {
	KeyID    uint64
	OldValue []byte
}

var (
	zstdEncoder *zstd.Encoder
	zstdDecoder *zstd.Decoder
)

func init() {
	zstdEncoder, _ = zstd.NewWriter(nil, zstd.WithEncoderLevel(zstd.SpeedDefault))
	zstdDecoder, _ = zstd.NewReader(nil)
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

func WriteChangeset(tx *mdbx.Txn, db *DB, blockNum uint64, changes []Change) error {
	raw := encodeChangeset(changes)
	compressed := zstdEncoder.EncodeAll(raw, nil)
	key := BlockKey(blockNum)
	return tx.Put(db.Changesets, key[:], compressed, 0)
}

func ReadChangeset(tx *mdbx.Txn, db *DB, blockNum uint64) ([]Change, error) {
	key := BlockKey(blockNum)
	compressed, err := tx.Get(db.Changesets, key[:])
	if err != nil {
		return nil, err
	}
	raw, err := zstdDecoder.DecodeAll(compressed, nil)
	if err != nil {
		return nil, fmt.Errorf("zstd decompress: %w", err)
	}
	return decodeChangeset(raw)
}

const maxShardSize = 2000

func UpdateHistoryIndex(tx *mdbx.Txn, db *DB, keyID uint64, blockNum uint64) error {
	cursor, err := tx.OpenCursor(db.HistoryIndex)
	if err != nil {
		return err
	}
	defer cursor.Close()

	seekKey := HistoryKey(keyID, blockNum)
	prefix := KeyIDBytes(keyID)

	k, v, err := cursor.Get(seekKey[:], nil, mdbx.SetRange)
	if err != nil && !mdbx.IsNotFound(err) {
		return err
	}

	if err == nil && bytes.HasPrefix(k, prefix[:]) {
		// Existing shard found
		bm := roaring64.NewBitmap()
		if _, err := bm.ReadFrom(bytes.NewReader(v)); err != nil {
			return fmt.Errorf("decode bitmap: %w", err)
		}
		bm.Add(blockNum)

		if bm.GetCardinality() > maxShardSize {
			// Seal current shard with actual max as key
			maxBlock := bm.Maximum()
			sealKey := HistoryKey(keyID, maxBlock)
			var buf bytes.Buffer
			if _, err := bm.WriteTo(&buf); err != nil {
				return err
			}
			if err := tx.Put(db.HistoryIndex, sealKey[:], buf.Bytes(), 0); err != nil {
				return err
			}
			// Delete old sentinel if key differs
			if !bytes.Equal(k, sealKey[:]) {
				if err := tx.Del(db.HistoryIndex, k, nil); err != nil {
					return err
				}
			}
			// Create new sentinel with just blockNum
			newBm := roaring64.NewBitmap()
			newBm.Add(blockNum)
			buf.Reset()
			if _, err := newBm.WriteTo(&buf); err != nil {
				return err
			}
			sentinel := HistoryKey(keyID, 0xFFFFFFFFFFFFFFFF)
			return tx.Put(db.HistoryIndex, sentinel[:], buf.Bytes(), 0)
		}

		// Write updated bitmap back to same key
		var buf bytes.Buffer
		if _, err := bm.WriteTo(&buf); err != nil {
			return err
		}
		return tx.Put(db.HistoryIndex, k, buf.Bytes(), 0)
	}

	// No shard for this keyID yet — create sentinel
	bm := roaring64.NewBitmap()
	bm.Add(blockNum)
	var buf bytes.Buffer
	if _, err := bm.WriteTo(&buf); err != nil {
		return err
	}
	sentinel := HistoryKey(keyID, 0xFFFFFFFFFFFFFFFF)
	return tx.Put(db.HistoryIndex, sentinel[:], buf.Bytes(), 0)
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
