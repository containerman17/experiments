package statetrie

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"log"
	"runtime"
	"sort"
	"sync"
	"time"

	"github.com/ava-labs/libevm/crypto"
	"github.com/erigontech/mdbx-go/mdbx"

	"block_fetcher/store"
)

// RawChange captures a pre-keyID changeset entry using raw (addr, slot) tuples.
// KeyIDs are assigned during Flush when a RW transaction is available.
type RawChange struct {
	Addr     [20]byte
	Slot     [32]byte // store.AccountSentinelSlot for account-level entries
	OldValue []byte
}

// BatchOverlay accumulates all state changes during a batch.
// Reads check the overlay first, then fall through to MDBX.
// At the end of the batch, everything is flushed in one MDBX transaction.
type BatchOverlay struct {
	mu sync.RWMutex

	// Plain state (for lightnode reads + changeset capture).
	accounts       map[[20]byte][]byte // addr → encoded account (104 bytes), nil = deleted
	storage        map[[52]byte][]byte // addr+slot → 32-byte value, nil = deleted
	accountDeleted map[[20]byte]bool
	storageDeleted map[[52]byte]bool

	// Hashed state (for trie root computation).
	hashedAccounts       map[[32]byte][]byte // keccak(addr) → encoded account
	hashedStorage        map[[64]byte][]byte // keccak(addr)+keccak(slot) → trimmed value
	hashedAccountDeleted map[[32]byte]bool
	hashedStorageDeleted map[[64]byte]bool

	// Code.
	code map[[32]byte][]byte // codeHash → bytecode

	// Raw changesets per block (keyIDs assigned during Flush).
	rawChangesets map[uint64][]RawChange

	// Receipts per block (receipts contain logs), captured during execution.
	blockReceipts map[uint64][]store.TxReceipt

	// Transaction hash index: txHash → (blockNum, txIndex).
	txHashes []TxHashEntry

	// Block hash index: blockHash → blockNum.
	blockHashes []BlockHashEntry

	// DEBUG: populated by ComputeIncrementalStateRoot step 1 for CompareLeafEncoding.
	DebugStep1Counts map[[32]byte]int
	DebugStep1Roots  map[[32]byte][32]byte
}

// TxHashEntry records a tx hash and its location.
type TxHashEntry struct {
	TxHash   [32]byte
	BlockNum uint64
	TxIndex  uint16
}

// BlockHashEntry records a block hash and its number.
type BlockHashEntry struct {
	BlockHash [32]byte
	BlockNum  uint64
}

func NewBatchOverlay() *BatchOverlay {
	return &BatchOverlay{
		accounts:             make(map[[20]byte][]byte),
		storage:              make(map[[52]byte][]byte),
		accountDeleted:       make(map[[20]byte]bool),
		storageDeleted:       make(map[[52]byte]bool),
		hashedAccounts:       make(map[[32]byte][]byte),
		hashedStorage:        make(map[[64]byte][]byte),
		hashedAccountDeleted: make(map[[32]byte]bool),
		hashedStorageDeleted: make(map[[64]byte]bool),
		code:                 make(map[[32]byte][]byte),
		rawChangesets:        make(map[uint64][]RawChange),
		blockReceipts:        make(map[uint64][]store.TxReceipt),
	}
}

// PutAccount writes an account to the overlay.
func (o *BatchOverlay) PutAccount(addr [20]byte, data []byte) {
	o.mu.Lock()
	o.accounts[addr] = data
	delete(o.accountDeleted, addr)

	var ha [32]byte
	copy(ha[:], crypto.Keccak256(addr[:]))
	o.hashedAccounts[ha] = data
	delete(o.hashedAccountDeleted, ha)
	o.mu.Unlock()
}

// DeleteAccount removes an account from the overlay.
func (o *BatchOverlay) DeleteAccount(addr [20]byte) {
	o.mu.Lock()
	delete(o.accounts, addr)
	o.accountDeleted[addr] = true

	var ha [32]byte
	copy(ha[:], crypto.Keccak256(addr[:]))
	delete(o.hashedAccounts, ha)
	o.hashedAccountDeleted[ha] = true
	o.mu.Unlock()
}

// PutStorage writes a storage slot to the overlay.
func (o *BatchOverlay) PutStorage(addr [20]byte, slot [32]byte, value [32]byte, trimmedValue []byte) {
	o.mu.Lock()
	var sk [52]byte
	copy(sk[:20], addr[:])
	copy(sk[20:], slot[:])
	val := make([]byte, 32)
	copy(val, value[:])
	o.storage[sk] = val
	delete(o.storageDeleted, sk)

	var hk [64]byte
	copy(hk[:32], crypto.Keccak256(addr[:]))
	copy(hk[32:], crypto.Keccak256(slot[:]))
	tv := make([]byte, len(trimmedValue))
	copy(tv, trimmedValue)
	o.hashedStorage[hk] = tv
	delete(o.hashedStorageDeleted, hk)
	o.mu.Unlock()
}

// DeleteStorage marks a storage slot as deleted.
func (o *BatchOverlay) DeleteStorage(addr [20]byte, slot [32]byte) {
	o.mu.Lock()
	var sk [52]byte
	copy(sk[:20], addr[:])
	copy(sk[20:], slot[:])
	delete(o.storage, sk)
	o.storageDeleted[sk] = true

	var hk [64]byte
	copy(hk[:32], crypto.Keccak256(addr[:]))
	copy(hk[32:], crypto.Keccak256(slot[:]))
	delete(o.hashedStorage, hk)
	o.hashedStorageDeleted[hk] = true
	o.mu.Unlock()
}

// PutCode writes contract code to the overlay.
func (o *BatchOverlay) PutCode(codeHash [32]byte, code []byte) {
	o.mu.Lock()
	c := make([]byte, len(code))
	copy(c, code)
	o.code[codeHash] = c
	o.mu.Unlock()
}

// AddBlockReceipts stores receipts (with embedded logs) for a block.
func (o *BatchOverlay) AddBlockReceipts(blockNum uint64, receipts []store.TxReceipt) {
	o.mu.Lock()
	o.blockReceipts[blockNum] = receipts
	o.mu.Unlock()
}

// AddTxHash records a transaction hash and its location.
func (o *BatchOverlay) AddTxHash(txHash [32]byte, blockNum uint64, txIndex uint16) {
	o.mu.Lock()
	o.txHashes = append(o.txHashes, TxHashEntry{TxHash: txHash, BlockNum: blockNum, TxIndex: txIndex})
	o.mu.Unlock()
}

// AddBlockHash records a block hash and its number.
func (o *BatchOverlay) AddBlockHash(blockHash [32]byte, blockNum uint64) {
	o.mu.Lock()
	o.blockHashes = append(o.blockHashes, BlockHashEntry{BlockHash: blockHash, BlockNum: blockNum})
	o.mu.Unlock()
}

// AddRawChangeset stores a block's raw changeset entries.
// KeyIDs will be assigned during Flush.
func (o *BatchOverlay) AddRawChangeset(blockNum uint64, changes []RawChange) {
	o.mu.Lock()
	o.rawChangesets[blockNum] = append(o.rawChangesets[blockNum], changes...)
	o.mu.Unlock()
}

// GetAccount reads from overlay first, then MDBX.
func (o *BatchOverlay) GetAccount(tx *mdbx.Txn, db *store.DB, addr [20]byte) (*store.Account, error) {
	o.mu.RLock()
	if o.accountDeleted[addr] {
		o.mu.RUnlock()
		return nil, nil
	}
	if data, ok := o.accounts[addr]; ok {
		o.mu.RUnlock()
		return store.DecodeAccount(data), nil
	}
	o.mu.RUnlock()
	return store.GetAccount(tx, db, addr)
}

// GetStorage reads from overlay first, then MDBX.
func (o *BatchOverlay) GetStorage(tx *mdbx.Txn, db *store.DB, addr [20]byte, slot [32]byte) ([32]byte, error) {
	o.mu.RLock()
	var sk [52]byte
	copy(sk[:20], addr[:])
	copy(sk[20:], slot[:])
	if o.storageDeleted[sk] {
		o.mu.RUnlock()
		return [32]byte{}, nil
	}
	if data, ok := o.storage[sk]; ok {
		o.mu.RUnlock()
		var val [32]byte
		copy(val[:], data)
		return val, nil
	}
	o.mu.RUnlock()
	return store.GetStorage(tx, db, addr, slot)
}

// GetCode reads from overlay first, then MDBX.
func (o *BatchOverlay) GetCode(tx *mdbx.Txn, db *store.DB, codeHash [32]byte) ([]byte, error) {
	o.mu.RLock()
	if code, ok := o.code[codeHash]; ok {
		o.mu.RUnlock()
		return code, nil
	}
	o.mu.RUnlock()
	return store.GetCode(tx, db, codeHash)
}

// GetHashedAccount checks overlay for a hashed account entry.
// Returns (deleted, value, found). If found && deleted, the account is deleted in
// the overlay. If found && !deleted, value is the overlay value.
func (o *BatchOverlay) GetHashedAccount(ha [32]byte) (deleted bool, value []byte, found bool) {
	o.mu.RLock()
	defer o.mu.RUnlock()
	if o.hashedAccountDeleted[ha] {
		return true, nil, true
	}
	if data, ok := o.hashedAccounts[ha]; ok {
		return false, data, true
	}
	return false, nil, false
}

// GetHashedStorage checks overlay for a hashed storage entry.
// Returns (deleted, value, found).
func (o *BatchOverlay) GetHashedStorage(hk [64]byte) (deleted bool, value []byte, found bool) {
	o.mu.RLock()
	defer o.mu.RUnlock()
	if o.hashedStorageDeleted[hk] {
		return true, nil, true
	}
	if data, ok := o.hashedStorage[hk]; ok {
		return false, data, true
	}
	return false, nil, false
}

// HashedAccountEntries returns a snapshot of all hashed account entries in the overlay.
func (o *BatchOverlay) HashedAccountEntries() map[[32]byte][]byte {
	o.mu.RLock()
	defer o.mu.RUnlock()
	result := make(map[[32]byte][]byte, len(o.hashedAccounts))
	for k, v := range o.hashedAccounts {
		result[k] = v
	}
	return result
}

// HashedStorageEntries returns a snapshot of all hashed storage entries in the overlay.
func (o *BatchOverlay) HashedStorageEntries() map[[64]byte][]byte {
	o.mu.RLock()
	defer o.mu.RUnlock()
	result := make(map[[64]byte][]byte, len(o.hashedStorage))
	for k, v := range o.hashedStorage {
		result[k] = v
	}
	return result
}

// ChangedAccountHashes returns all keccak(addr) keys touched during the batch.
func (o *BatchOverlay) ChangedAccountHashes() [][32]byte {
	o.mu.RLock()
	defer o.mu.RUnlock()
	seen := make(map[[32]byte]bool, len(o.hashedAccounts)+len(o.hashedAccountDeleted))
	for ha := range o.hashedAccounts {
		seen[ha] = true
	}
	for ha := range o.hashedAccountDeleted {
		seen[ha] = true
	}
	result := make([][32]byte, 0, len(seen))
	for ha := range seen {
		result = append(result, ha)
	}
	return result
}

// ChangedStorageGrouped returns changed storage slot hashes grouped by account hash.
func (o *BatchOverlay) ChangedStorageGrouped() map[[32]byte][][32]byte {
	o.mu.RLock()
	defer o.mu.RUnlock()
	result := make(map[[32]byte][][32]byte)
	for hk := range o.hashedStorage {
		var addrHash, slotHash [32]byte
		copy(addrHash[:], hk[:32])
		copy(slotHash[:], hk[32:])
		result[addrHash] = append(result[addrHash], slotHash)
	}
	for hk := range o.hashedStorageDeleted {
		var addrHash, slotHash [32]byte
		copy(addrHash[:], hk[:32])
		copy(slotHash[:], hk[32:])
		result[addrHash] = append(result[addrHash], slotHash)
	}
	return result
}

// ChangedStoragePlain returns changed raw storage slots grouped by plain address.
// Written values are 32-byte full words; deleted slots return nil.
func (o *BatchOverlay) ChangedStoragePlain() map[[20]byte]map[[32]byte][]byte {
	o.mu.RLock()
	defer o.mu.RUnlock()

	result := make(map[[20]byte]map[[32]byte][]byte)
	for sk, data := range o.storage {
		var addr [20]byte
		var slot [32]byte
		copy(addr[:], sk[:20])
		copy(slot[:], sk[20:])
		if result[addr] == nil {
			result[addr] = make(map[[32]byte][]byte)
		}
		val := make([]byte, len(data))
		copy(val, data)
		result[addr][slot] = val
	}
	for sk := range o.storageDeleted {
		var addr [20]byte
		var slot [32]byte
		copy(addr[:], sk[:20])
		copy(slot[:], sk[20:])
		if result[addr] == nil {
			result[addr] = make(map[[32]byte][]byte)
		}
		result[addr][slot] = nil
	}
	return result
}

// FlushStateToTx writes all state (accounts, storage, hashed state, code, changesets)
// to the given RW transaction. Does NOT set head block or commit.
func (o *BatchOverlay) FlushStateToTx(tx *mdbx.Txn, db *store.DB) error {
	t0 := time.Now()

	// Write accounts — sorted cursor for page locality.
	if err := flushMapSorted20(tx, db.AccountState, o.accounts); err != nil {
		return err
	}
	for addr := range o.accountDeleted {
		if err := tx.Del(db.AccountState, addr[:], nil); err != nil && !mdbx.IsNotFound(err) {
			return err
		}
	}

	// Write hashed accounts — sorted cursor.
	if err := flushMapSorted32(tx, db.HashedAccountState, o.hashedAccounts); err != nil {
		return err
	}
	for ha := range o.hashedAccountDeleted {
		if err := tx.Del(db.HashedAccountState, ha[:], nil); err != nil && !mdbx.IsNotFound(err) {
			return err
		}
	}

	// Write storage — sorted cursor via StorageKey order.
	if err := flushStorageSorted(tx, db, o.storage, o.storageDeleted); err != nil {
		return err
	}

	// Write hashed storage — sorted cursor.
	if err := flushMapSorted64(tx, db.HashedStorageState, o.hashedStorage); err != nil {
		return err
	}
	for hk := range o.hashedStorageDeleted {
		if err := tx.Del(db.HashedStorageState, hk[:], nil); err != nil && !mdbx.IsNotFound(err) {
			return err
		}
	}

	// Write code.
	for ch, code := range o.code {
		if err := store.PutCode(tx, db, ch, code); err != nil {
			return err
		}
	}

	t1 := time.Now()
	// Convert raw changesets to store.Change (with keyID assignment) and write.
	// Accumulate history index updates per keyID for batched flush.
	historyPending := make(map[uint64][]uint64, 4096)
	for blockNum, rawChanges := range o.rawChangesets {
		if len(rawChanges) == 0 {
			continue
		}
		changes := make([]store.Change, 0, len(rawChanges))
		for _, rc := range rawChanges {
			keyID, err := store.GetOrAssignKeyID(tx, db, rc.Addr, rc.Slot)
			if err != nil {
				return fmt.Errorf("assign keyID for changeset at block %d: %w", blockNum, err)
			}
			changes = append(changes, store.Change{KeyID: keyID, OldValue: rc.OldValue})
		}
		if err := store.WriteChangeset(tx, db, blockNum, changes); err != nil {
			return err
		}
		for _, c := range changes {
			historyPending[c.KeyID] = append(historyPending[c.KeyID], blockNum)
		}
	}
	t2 := time.Now()
	if err := store.FlushHistoryIndexBatch(tx, db, historyPending); err != nil {
		return fmt.Errorf("flush history index batch: %w", err)
	}
	t3 := time.Now()

	// Write block receipts and accumulate log index updates for batched flush.
	addrLogPending := make(map[string][]uint64, 4096)
	topicLogPending := make(map[string][]uint64, 4096)
	for blockNum, receipts := range o.blockReceipts {
		if len(receipts) == 0 {
			continue
		}
		if err := store.WriteBlockReceipts(tx, db, blockNum, receipts); err != nil {
			return fmt.Errorf("write block receipts at block %d: %w", blockNum, err)
		}
		seen := make(map[[20]byte]bool)
		seenTopics := make(map[[32]byte]bool)
		for _, r := range receipts {
			for _, l := range r.Logs {
				if !seen[l.Address] {
					seen[l.Address] = true
					addrLogPending[string(l.Address[:])] = append(addrLogPending[string(l.Address[:])], blockNum)
				}
				for _, t := range l.Topics {
					if !seenTopics[t] {
						seenTopics[t] = true
						topicLogPending[string(t[:])] = append(topicLogPending[string(t[:])], blockNum)
					}
				}
			}
		}
	}
	t4 := time.Now()
	if err := store.FlushLogIndexBatch(tx, db.AddressLogIndex, addrLogPending); err != nil {
		return fmt.Errorf("flush address log index batch: %w", err)
	}
	if err := store.FlushLogIndexBatch(tx, db.TopicLogIndex, topicLogPending); err != nil {
		return fmt.Errorf("flush topic log index batch: %w", err)
	}
	t5 := time.Now()

	// Write tx hash index — single cursor, sorted by hash.
	storeEntries := make([]store.TxHashEntry, len(o.txHashes))
	for i, e := range o.txHashes {
		storeEntries[i] = store.TxHashEntry{TxHash: e.TxHash, BlockNum: e.BlockNum, TxIndex: e.TxIndex}
	}
	if err := store.FlushTxHashBatch(tx, db, storeEntries); err != nil {
		return fmt.Errorf("flush tx hash batch: %w", err)
	}

	// Write block hash → block number index — single cursor.
	{
		cursor, err := tx.OpenCursor(db.BlockHashIndex)
		if err != nil {
			return fmt.Errorf("open block hash cursor: %w", err)
		}
		var val [8]byte
		for _, entry := range o.blockHashes {
			binary.BigEndian.PutUint64(val[:], entry.BlockNum)
			if err := cursor.Put(entry.BlockHash[:], val[:], 0); err != nil {
				cursor.Close()
				return fmt.Errorf("write block hash index: %w", err)
			}
		}
		cursor.Close()
	}

	t6 := time.Now()
	log.Printf("flush-breakdown: state=%s changesets=%s histIdx=%s receipts=%s logIdx=%s txIdx=%s histKeys=%d addrKeys=%d topicKeys=%d",
		t1.Sub(t0).Truncate(time.Millisecond),
		t2.Sub(t1).Truncate(time.Millisecond),
		t3.Sub(t2).Truncate(time.Millisecond),
		t4.Sub(t3).Truncate(time.Millisecond),
		t5.Sub(t4).Truncate(time.Millisecond),
		t6.Sub(t5).Truncate(time.Millisecond),
		len(historyPending), len(addrLogPending), len(topicLogPending))

	return nil
}

// Flush writes everything to MDBX in a single transaction.
func (o *BatchOverlay) Flush(db *store.DB, headBlock uint64) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	tx, err := db.BeginRW()
	if err != nil {
		return err
	}

	// Write accounts.
	for addr, data := range o.accounts {
		if err := tx.Put(db.AccountState, addr[:], data, 0); err != nil {
			tx.Abort()
			return err
		}
	}
	for addr := range o.accountDeleted {
		if err := tx.Del(db.AccountState, addr[:], nil); err != nil && !mdbx.IsNotFound(err) {
			tx.Abort()
			return err
		}
	}

	// Write hashed accounts.
	for ha, data := range o.hashedAccounts {
		if err := tx.Put(db.HashedAccountState, ha[:], data, 0); err != nil {
			tx.Abort()
			return err
		}
	}
	for ha := range o.hashedAccountDeleted {
		if err := tx.Del(db.HashedAccountState, ha[:], nil); err != nil && !mdbx.IsNotFound(err) {
			tx.Abort()
			return err
		}
	}

	// Write storage (using store.PutStorage for correct trimming/deletion behavior).
	for sk, data := range o.storage {
		var addr [20]byte
		var slot [32]byte
		copy(addr[:], sk[:20])
		copy(slot[:], sk[20:])
		var val32 [32]byte
		copy(val32[:], data)
		if err := store.PutStorage(tx, db, addr, slot, val32); err != nil {
			tx.Abort()
			return err
		}
	}
	for sk := range o.storageDeleted {
		var addr [20]byte
		var slot [32]byte
		copy(addr[:], sk[:20])
		copy(slot[:], sk[20:])
		var zeroVal [32]byte
		if err := store.PutStorage(tx, db, addr, slot, zeroVal); err != nil {
			tx.Abort()
			return err
		}
	}

	// Write hashed storage.
	for hk, data := range o.hashedStorage {
		if err := tx.Put(db.HashedStorageState, hk[:], data, 0); err != nil {
			tx.Abort()
			return err
		}
	}
	for hk := range o.hashedStorageDeleted {
		if err := tx.Del(db.HashedStorageState, hk[:], nil); err != nil && !mdbx.IsNotFound(err) {
			tx.Abort()
			return err
		}
	}

	// Write code.
	for ch, code := range o.code {
		if err := store.PutCode(tx, db, ch, code); err != nil {
			tx.Abort()
			return err
		}
	}

	// Convert raw changesets to store.Change (with keyID assignment) and write.
	for blockNum, rawChanges := range o.rawChangesets {
		if len(rawChanges) == 0 {
			continue
		}
		changes := make([]store.Change, 0, len(rawChanges))
		for _, rc := range rawChanges {
			keyID, err := store.GetOrAssignKeyID(tx, db, rc.Addr, rc.Slot)
			if err != nil {
				tx.Abort()
				return fmt.Errorf("assign keyID for changeset at block %d: %w", blockNum, err)
			}
			changes = append(changes, store.Change{KeyID: keyID, OldValue: rc.OldValue})
		}
		if err := store.WriteChangeset(tx, db, blockNum, changes); err != nil {
			tx.Abort()
			return err
		}
		for _, c := range changes {
			if err := store.UpdateHistoryIndex(tx, db, c.KeyID, blockNum); err != nil {
				tx.Abort()
				return err
			}
		}
	}

	// Update head block.
	if err := store.SetHeadBlock(tx, db, headBlock); err != nil {
		tx.Abort()
		return err
	}

	_, err = tx.Commit()
	return err
}

// flushMapSorted20 writes a map[[20]byte][]byte to dbi using a sorted cursor.
func flushMapSorted20(tx *mdbx.Txn, dbi mdbx.DBI, m map[[20]byte][]byte) error {
	if len(m) == 0 {
		return nil
	}
	keys := make([][20]byte, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		return bytes.Compare(keys[i][:], keys[j][:]) < 0
	})
	cursor, err := tx.OpenCursor(dbi)
	if err != nil {
		return err
	}
	defer cursor.Close()
	for _, k := range keys {
		if err := cursor.Put(k[:], m[k], 0); err != nil {
			return err
		}
	}
	return nil
}

// flushMapSorted32 writes a map[[32]byte][]byte to dbi using a sorted cursor.
func flushMapSorted32(tx *mdbx.Txn, dbi mdbx.DBI, m map[[32]byte][]byte) error {
	if len(m) == 0 {
		return nil
	}
	keys := make([][32]byte, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		return bytes.Compare(keys[i][:], keys[j][:]) < 0
	})
	cursor, err := tx.OpenCursor(dbi)
	if err != nil {
		return err
	}
	defer cursor.Close()
	for _, k := range keys {
		if err := cursor.Put(k[:], m[k], 0); err != nil {
			return err
		}
	}
	return nil
}

// flushMapSorted64 writes a map[[64]byte][]byte to dbi using a sorted cursor.
func flushMapSorted64(tx *mdbx.Txn, dbi mdbx.DBI, m map[[64]byte][]byte) error {
	if len(m) == 0 {
		return nil
	}
	keys := make([][64]byte, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		return bytes.Compare(keys[i][:], keys[j][:]) < 0
	})
	cursor, err := tx.OpenCursor(dbi)
	if err != nil {
		return err
	}
	defer cursor.Close()
	for _, k := range keys {
		if err := cursor.Put(k[:], m[k], 0); err != nil {
			return err
		}
	}
	return nil
}

// flushStorageSorted writes storage entries and deletes in sorted key order.
func flushStorageSorted(tx *mdbx.Txn, db *store.DB, storage map[[52]byte][]byte, deleted map[[52]byte]bool) error {
	if len(storage) == 0 && len(deleted) == 0 {
		return nil
	}
	cursor, err := tx.OpenCursor(db.StorageState)
	if err != nil {
		return err
	}
	defer cursor.Close()

	// Merge puts and deletes into sorted order.
	type entry struct {
		key    [52]byte
		value  []byte
		delete bool
	}
	entries := make([]entry, 0, len(storage)+len(deleted))
	for sk, data := range storage {
		entries = append(entries, entry{key: sk, value: data})
	}
	for sk := range deleted {
		entries = append(entries, entry{key: sk, delete: true})
	}
	sort.Slice(entries, func(i, j int) bool {
		return bytes.Compare(entries[i].key[:], entries[j].key[:]) < 0
	})

	for _, e := range entries {
		storageKey := store.StorageKey(
			*(*[20]byte)(e.key[:20]),
			*(*[32]byte)(e.key[20:]),
		)
		if e.delete {
			// For deletes, use tx.Del (cursor.Del requires positioning first).
			if err := tx.Del(db.StorageState, storageKey[:], nil); err != nil && !mdbx.IsNotFound(err) {
				return err
			}
			continue
		}
		var val32 [32]byte
		copy(val32[:], e.value)
		if val32 == [32]byte{} {
			if err := tx.Del(db.StorageState, storageKey[:], nil); err != nil && !mdbx.IsNotFound(err) {
				return err
			}
			continue
		}
		v := val32[:]
		for len(v) > 1 && v[0] == 0 {
			v = v[1:]
		}
		if err := cursor.Put(storageKey[:], v, 0); err != nil {
			return err
		}
	}
	return nil
}
