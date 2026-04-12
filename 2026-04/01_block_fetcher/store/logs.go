package store

import (
	"bytes"
	"encoding/binary"
	"fmt"

	"github.com/RoaringBitmap/roaring/v2/roaring64"
	"github.com/erigontech/mdbx-go/mdbx"
	"github.com/pierrec/lz4/v4"
)

// TxReceipt holds receipt metadata + logs for a single transaction.
type TxReceipt struct {
	TxHash          [32]byte
	Status          uint8  // 0 = failed, 1 = success
	CumulativeGas   uint64
	GasUsed         uint64
	TxType          uint8
	ContractAddress [20]byte // zero if no contract created
	Logs            []LogEntry
}

// LogEntry represents a single event log within a receipt.
type LogEntry struct {
	Address [20]byte
	Topics  [][32]byte // 0-4 topics
	Data    []byte
}

// encodeBlockReceipts encodes all receipts for a block.
// Format:
//
//	numTxs(4)
//	per tx:
//	  txHash(32) | status(1) | cumulativeGas(8) | gasUsed(8) | txType(1) |
//	  contractAddr(20) | numLogs(2) |
//	  per log:
//	    address(20) | nTopics(1) | topics(N*32) | dataLen(2) | data
func encodeBlockReceipts(receipts []TxReceipt) []byte {
	size := 4
	for _, r := range receipts {
		size += 32 + 1 + 8 + 8 + 1 + 20 + 2
		for _, l := range r.Logs {
			size += 20 + 1 + len(l.Topics)*32 + 2 + len(l.Data)
		}
	}
	buf := make([]byte, size)
	binary.BigEndian.PutUint32(buf[0:4], uint32(len(receipts)))
	off := 4
	for _, r := range receipts {
		copy(buf[off:off+32], r.TxHash[:])
		off += 32
		buf[off] = r.Status
		off++
		binary.BigEndian.PutUint64(buf[off:off+8], r.CumulativeGas)
		off += 8
		binary.BigEndian.PutUint64(buf[off:off+8], r.GasUsed)
		off += 8
		buf[off] = r.TxType
		off++
		copy(buf[off:off+20], r.ContractAddress[:])
		off += 20
		binary.BigEndian.PutUint16(buf[off:off+2], uint16(len(r.Logs)))
		off += 2
		for _, l := range r.Logs {
			copy(buf[off:off+20], l.Address[:])
			off += 20
			buf[off] = byte(len(l.Topics))
			off++
			for _, t := range l.Topics {
				copy(buf[off:off+32], t[:])
				off += 32
			}
			binary.BigEndian.PutUint16(buf[off:off+2], uint16(len(l.Data)))
			off += 2
			copy(buf[off:], l.Data)
			off += len(l.Data)
		}
	}
	return buf[:off]
}

// DecodeBlockReceipts decodes the binary format back into receipts.
func DecodeBlockReceipts(data []byte) ([]TxReceipt, error) {
	if len(data) < 4 {
		return nil, fmt.Errorf("receipt data too short")
	}
	n := binary.BigEndian.Uint32(data[0:4])
	receipts := make([]TxReceipt, 0, n)
	off := 4
	for range n {
		if off+70 > len(data) {
			return nil, fmt.Errorf("receipt data truncated at header")
		}
		var r TxReceipt
		copy(r.TxHash[:], data[off:off+32])
		off += 32
		r.Status = data[off]
		off++
		r.CumulativeGas = binary.BigEndian.Uint64(data[off : off+8])
		off += 8
		r.GasUsed = binary.BigEndian.Uint64(data[off : off+8])
		off += 8
		r.TxType = data[off]
		off++
		copy(r.ContractAddress[:], data[off:off+20])
		off += 20
		if off+2 > len(data) {
			return nil, fmt.Errorf("receipt data truncated at log count")
		}
		numLogs := int(binary.BigEndian.Uint16(data[off : off+2]))
		off += 2
		r.Logs = make([]LogEntry, 0, numLogs)
		for range numLogs {
			if off+21 > len(data) {
				return nil, fmt.Errorf("log data truncated")
			}
			var l LogEntry
			copy(l.Address[:], data[off:off+20])
			off += 20
			nTopics := int(data[off])
			off++
			if off+nTopics*32 > len(data) {
				return nil, fmt.Errorf("log data truncated at topics")
			}
			l.Topics = make([][32]byte, nTopics)
			for i := range nTopics {
				copy(l.Topics[i][:], data[off:off+32])
				off += 32
			}
			if off+2 > len(data) {
				return nil, fmt.Errorf("log data truncated at data len")
			}
			dataLen := int(binary.BigEndian.Uint16(data[off : off+2]))
			off += 2
			if off+dataLen > len(data) {
				return nil, fmt.Errorf("log data truncated at data")
			}
			l.Data = make([]byte, dataLen)
			copy(l.Data, data[off:off+dataLen])
			off += dataLen
			r.Logs = append(r.Logs, l)
		}
		receipts = append(receipts, r)
	}
	return receipts, nil
}

// Reusable buffers for receipt compression (single-threaded flush).
var (
	rcptLZ4HashTable = make([]int, 1<<16)
	rcptLZ4CompBuf   []byte
)

// WriteBlockReceipts writes all receipts for a block, LZ4 compressed.
func WriteBlockReceipts(tx *mdbx.Txn, db *DB, blockNum uint64, receipts []TxReceipt) error {
	raw := encodeBlockReceipts(receipts)
	needed := lz4.CompressBlockBound(len(raw))
	if cap(rcptLZ4CompBuf) < needed {
		rcptLZ4CompBuf = make([]byte, needed)
	}
	buf := rcptLZ4CompBuf[:needed]
	for i := range rcptLZ4HashTable {
		rcptLZ4HashTable[i] = 0
	}
	n, _ := lz4.CompressBlock(raw, buf, rcptLZ4HashTable)
	key := BlockKey(blockNum)
	if n == 0 {
		out := make([]byte, 1+len(raw))
		out[0] = 0
		copy(out[1:], raw)
		return tx.Put(db.ReceiptsByBlock, key[:], out, 0)
	}
	out := make([]byte, 1+n)
	out[0] = 1
	copy(out[1:], buf[:n])
	return tx.Put(db.ReceiptsByBlock, key[:], out, 0)
}

// ReadBlockReceipts reads and decompresses receipts for a block.
func ReadBlockReceipts(tx *mdbx.Txn, db *DB, blockNum uint64) ([]TxReceipt, error) {
	key := BlockKey(blockNum)
	data, err := tx.Get(db.ReceiptsByBlock, key[:])
	if err != nil {
		if mdbx.IsNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	if len(data) == 0 {
		return nil, nil
	}
	var raw []byte
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
			return nil, fmt.Errorf("lz4 decompress failed for block %d receipts", blockNum)
		}
	}
	return DecodeBlockReceipts(raw)
}

// PutTxHash stores a txHash → (blockNum, txIndex) mapping.
func PutTxHash(tx *mdbx.Txn, db *DB, txHash [32]byte, blockNum uint64, txIndex uint16) error {
	var val [10]byte
	binary.BigEndian.PutUint64(val[0:8], blockNum)
	binary.BigEndian.PutUint16(val[8:10], txIndex)
	return tx.Put(db.TxHashIndex, txHash[:], val[:], 0)
}

// GetTxLocation looks up a transaction's block number and index by hash.
func GetTxLocation(tx *mdbx.Txn, db *DB, txHash [32]byte) (blockNum uint64, txIndex uint16, err error) {
	val, err := tx.Get(db.TxHashIndex, txHash[:])
	if err != nil {
		return 0, 0, err
	}
	if len(val) < 10 {
		return 0, 0, fmt.Errorf("tx hash index entry too short")
	}
	return binary.BigEndian.Uint64(val[0:8]), binary.BigEndian.Uint16(val[8:10]), nil
}

const maxLogShardSize = 50000

// Reusable bitmap and buffer for log index updates.
var (
	logBitmap  = roaring64.NewBitmap()
	logBuf     bytes.Buffer
	logKeyCopy [60]byte
	logValBuf  []byte
)

// UpdateAddressLogIndex adds a blockNum to the address's log bitmap.
func UpdateAddressLogIndex(tx *mdbx.Txn, db *DB, address [20]byte, blockNum uint64) error {
	return updateLogIndex(tx, db.AddressLogIndex, address[:], blockNum)
}

// UpdateTopicLogIndex adds a blockNum to the topic's log bitmap.
func UpdateTopicLogIndex(tx *mdbx.Txn, db *DB, topic [32]byte, blockNum uint64) error {
	return updateLogIndex(tx, db.TopicLogIndex, topic[:], blockNum)
}

// updateLogIndex is the generic bitmap-sharded index update.
func updateLogIndex(tx *mdbx.Txn, dbi mdbx.DBI, prefix []byte, blockNum uint64) error {
	cursor, err := tx.OpenCursor(dbi)
	if err != nil {
		return err
	}
	defer cursor.Close()

	seekKey := make([]byte, len(prefix)+8)
	copy(seekKey, prefix)
	binary.BigEndian.PutUint64(seekKey[len(prefix):], blockNum)

	kRaw, v, err := cursor.Get(seekKey, nil, mdbx.SetRange)
	if err != nil && !mdbx.IsNotFound(err) {
		return err
	}

	var k []byte
	if err == nil {
		if len(kRaw) > len(logKeyCopy) {
			k = make([]byte, len(kRaw))
		} else {
			k = logKeyCopy[:len(kRaw)]
		}
		copy(k, kRaw)
		if cap(logValBuf) < len(v) {
			logValBuf = make([]byte, len(v))
		}
		logValBuf = logValBuf[:len(v)]
		copy(logValBuf, v)
	}

	if err == nil && len(k) >= len(prefix)+8 && bytes.HasPrefix(k, prefix) {
		logBitmap.Clear()
		if _, err := logBitmap.ReadFrom(bytes.NewReader(logValBuf)); err != nil {
			return fmt.Errorf("decode log bitmap: %w", err)
		}
		logBitmap.Add(blockNum)

		if logBitmap.GetCardinality() > maxLogShardSize {
			maxBlock := logBitmap.Maximum()
			sealKey := make([]byte, len(prefix)+8)
			copy(sealKey, prefix)
			binary.BigEndian.PutUint64(sealKey[len(prefix):], maxBlock)
			logBuf.Reset()
			if _, err := logBitmap.WriteTo(&logBuf); err != nil {
				return err
			}
			if err := tx.Put(dbi, sealKey, logBuf.Bytes(), 0); err != nil {
				return err
			}
			if !bytes.Equal(k, sealKey) {
				if err := tx.Del(dbi, k, nil); err != nil {
					return err
				}
			}
			logBitmap.Clear()
			logBitmap.Add(blockNum)
			logBuf.Reset()
			if _, err := logBitmap.WriteTo(&logBuf); err != nil {
				return err
			}
			sentinel := make([]byte, len(prefix)+8)
			copy(sentinel, prefix)
			binary.BigEndian.PutUint64(sentinel[len(prefix):], 0xFFFFFFFFFFFFFFFF)
			return tx.Put(dbi, sentinel, logBuf.Bytes(), 0)
		}

		logBuf.Reset()
		if _, err := logBitmap.WriteTo(&logBuf); err != nil {
			return err
		}
		return tx.Put(dbi, k, logBuf.Bytes(), 0)
	}

	logBitmap.Clear()
	logBitmap.Add(blockNum)
	logBuf.Reset()
	if _, err := logBitmap.WriteTo(&logBuf); err != nil {
		return err
	}
	sentinel := make([]byte, len(prefix)+8)
	copy(sentinel, prefix)
	binary.BigEndian.PutUint64(sentinel[len(prefix):], 0xFFFFFFFFFFFFFFFF)
	return tx.Put(dbi, sentinel, logBuf.Bytes(), 0)
}
