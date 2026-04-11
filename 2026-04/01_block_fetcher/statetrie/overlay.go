package statetrie

import (
	"fmt"
	"runtime"
	"sync"

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

// FlushStateToTx writes all state (accounts, storage, hashed state, code, changesets)
// to the given RW transaction. Does NOT set head block or commit.
func (o *BatchOverlay) FlushStateToTx(tx *mdbx.Txn, db *store.DB) error {
	// Write accounts.
	for addr, data := range o.accounts {
		if err := tx.Put(db.AccountState, addr[:], data, 0); err != nil {
			return err
		}
	}
	for addr := range o.accountDeleted {
		if err := tx.Del(db.AccountState, addr[:], nil); err != nil && !mdbx.IsNotFound(err) {
			return err
		}
	}

	// Write hashed accounts.
	for ha, data := range o.hashedAccounts {
		if err := tx.Put(db.HashedAccountState, ha[:], data, 0); err != nil {
			return err
		}
	}
	for ha := range o.hashedAccountDeleted {
		if err := tx.Del(db.HashedAccountState, ha[:], nil); err != nil && !mdbx.IsNotFound(err) {
			return err
		}
	}

	// Write storage.
	for sk, data := range o.storage {
		var addr [20]byte
		var slot [32]byte
		copy(addr[:], sk[:20])
		copy(slot[:], sk[20:])
		var val32 [32]byte
		copy(val32[:], data)
		if err := store.PutStorage(tx, db, addr, slot, val32); err != nil {
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
			return err
		}
	}

	// Write hashed storage.
	for hk, data := range o.hashedStorage {
		if err := tx.Put(db.HashedStorageState, hk[:], data, 0); err != nil {
			return err
		}
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

	// Convert raw changesets to store.Change (with keyID assignment) and write.
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
			if err := store.UpdateHistoryIndex(tx, db, c.KeyID, blockNum); err != nil {
				return err
			}
		}
	}
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
