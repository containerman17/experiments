package executor

import (
	"math/big"

	cparams "github.com/ava-labs/avalanchego/graft/coreth/params"
	"github.com/ava-labs/avalanchego/vms/evm/predicate"
	"github.com/ava-labs/libevm/common"
	"github.com/ava-labs/libevm/core/types"
	"github.com/ava-labs/libevm/core/vm"
	"github.com/ava-labs/libevm/crypto"
	"github.com/ava-labs/libevm/libevm/stateconf"
	"github.com/ava-labs/libevm/params"
	"github.com/erigontech/mdbx-go/mdbx"
	"github.com/holiman/uint256"

	"block_fetcher/store"
)

// Ensure interface compliance.
var _ vm.StateDB = (*StateDB)(nil)

// ─── Journal entries for snapshot/revert ────────────────────────────

type journalEntry interface {
	revert(s *StateDB)
}

type journalStorageChange struct {
	addr common.Address
	key  common.Hash
	prev common.Hash
	had  bool
}

func (j journalStorageChange) revert(s *StateDB) {
	if !j.had {
		delete(s.storageOverrides[j.addr], j.key)
		if len(s.storageOverrides[j.addr]) == 0 {
			delete(s.storageOverrides, j.addr)
		}
	} else {
		s.storageOverrides[j.addr][j.key] = j.prev
	}
}

type journalBalanceChange struct {
	addr common.Address
	prev *uint256.Int
	had  bool
}

func (j journalBalanceChange) revert(s *StateDB) {
	if !j.had {
		delete(s.balanceOverrides, j.addr)
	} else {
		s.balanceOverrides[j.addr] = j.prev
	}
}

type journalNonceChange struct {
	addr common.Address
	prev uint64
	had  bool
}

func (j journalNonceChange) revert(s *StateDB) {
	if !j.had {
		delete(s.nonceOverrides, j.addr)
	} else {
		s.nonceOverrides[j.addr] = j.prev
	}
}

type journalCodeChange struct {
	addr common.Address
	prev []byte
	had  bool
}

func (j journalCodeChange) revert(s *StateDB) {
	if !j.had {
		delete(s.codeOverrides, j.addr)
		delete(s.codeHashCache, j.addr)
		return
	}
	s.codeOverrides[j.addr] = append([]byte(nil), j.prev...)
	if len(j.prev) > 0 {
		s.codeHashCache[j.addr] = crypto.Keccak256Hash(j.prev)
	} else {
		delete(s.codeHashCache, j.addr)
	}
}

type journalRefundChange struct {
	prev uint64
}

func (j journalRefundChange) revert(s *StateDB) {
	s.refund = j.prev
}

type journalAccessListAddr struct {
	addr common.Address
}

func (j journalAccessListAddr) revert(s *StateDB) {
	delete(s.accessList, j.addr)
}

// ─── StateDB ───────────────────────────────────────────────────────

type StateDB struct {
	tx *mdbx.Txn // RO transaction for reading base state
	db *store.DB

	// Write overlay
	storageOverrides map[common.Address]map[common.Hash]common.Hash
	balanceOverrides map[common.Address]*uint256.Int
	nonceOverrides   map[common.Address]uint64
	codeOverrides    map[common.Address][]byte
	codeHashCache    map[common.Address]common.Hash
	destructed       map[common.Address]bool

	// Journal for snapshot/revert
	journal   []journalEntry
	snapshots []int // journal length at each snapshot

	// EVM per-tx state
	accessList       map[common.Address]map[common.Hash]bool
	refund           uint64
	logs             []*types.Log
	txHash           common.Hash
	txIndex          int
	transientStorage map[common.Address]map[common.Hash]common.Hash
	predicates       map[common.Address][]predicate.Predicate
}

// NewStateDB creates a new StateDB backed by an MDBX read-only transaction.
func NewStateDB(tx *mdbx.Txn, db *store.DB) *StateDB {
	return &StateDB{
		tx:               tx,
		db:               db,
		storageOverrides: make(map[common.Address]map[common.Hash]common.Hash),
		balanceOverrides: make(map[common.Address]*uint256.Int),
		nonceOverrides:   make(map[common.Address]uint64),
		codeOverrides:    make(map[common.Address][]byte),
		codeHashCache:    make(map[common.Address]common.Hash),
		destructed:       make(map[common.Address]bool),
		accessList:       make(map[common.Address]map[common.Hash]bool),
		transientStorage: make(map[common.Address]map[common.Hash]common.Hash),
		predicates:       make(map[common.Address][]predicate.Predicate),
	}
}

// ─── Storage ───────────────────────────────────────────────────────

func (s *StateDB) GetState(addr common.Address, key common.Hash, _ ...stateconf.StateDBStateOption) common.Hash {
	// Check overlay first
	if slots, ok := s.storageOverrides[addr]; ok {
		if val, ok := slots[key]; ok {
			return val
		}
	}
	// Read from MDBX
	var addr20 [20]byte
	var slot32 [32]byte
	copy(addr20[:], addr[:])
	copy(slot32[:], key[:])
	val, err := store.GetStorage(s.tx, s.db, addr20, slot32)
	if err != nil {
		return common.Hash{}
	}
	return common.Hash(val)
}

func (s *StateDB) GetCommittedState(addr common.Address, key common.Hash, _ ...stateconf.StateDBStateOption) common.Hash {
	// Committed state = base MDBX state, bypass overlay
	var addr20 [20]byte
	var slot32 [32]byte
	copy(addr20[:], addr[:])
	copy(slot32[:], key[:])
	val, err := store.GetStorage(s.tx, s.db, addr20, slot32)
	if err != nil {
		return common.Hash{}
	}
	return common.Hash(val)
}

func (s *StateDB) SetState(addr common.Address, key, value common.Hash, _ ...stateconf.StateDBStateOption) {
	var prev common.Hash
	var had bool
	if slots, ok := s.storageOverrides[addr]; ok {
		prev, had = slots[key]
	}
	s.journal = append(s.journal, journalStorageChange{addr, key, prev, had})
	if s.storageOverrides[addr] == nil {
		s.storageOverrides[addr] = make(map[common.Hash]common.Hash)
	}
	s.storageOverrides[addr][key] = value
}

// ─── Balance ───────────────────────────────────────────────────────

func (s *StateDB) GetBalance(addr common.Address) *uint256.Int {
	if bal, ok := s.balanceOverrides[addr]; ok {
		return new(uint256.Int).Set(bal)
	}
	// Read from MDBX
	var addr20 [20]byte
	copy(addr20[:], addr[:])
	acct, err := store.GetAccount(s.tx, s.db, addr20)
	if err != nil || acct == nil {
		return uint256.NewInt(0)
	}
	return new(uint256.Int).SetBytes32(acct.Balance[:])
}

func (s *StateDB) SubBalance(addr common.Address, amount *uint256.Int) {
	prev, had := s.balanceOverrides[addr]
	if had {
		prev = prev.Clone()
	}
	s.journal = append(s.journal, journalBalanceChange{addr, prev, had})
	bal := s.GetBalance(addr)
	s.balanceOverrides[addr] = new(uint256.Int).Sub(bal, amount)
}

func (s *StateDB) AddBalance(addr common.Address, amount *uint256.Int) {
	prev, had := s.balanceOverrides[addr]
	if had {
		prev = prev.Clone()
	}
	s.journal = append(s.journal, journalBalanceChange{addr, prev, had})
	bal := s.GetBalance(addr)
	s.balanceOverrides[addr] = new(uint256.Int).Add(bal, amount)
}

// ─── Nonce ─────────────────────────────────────────────────────────

func (s *StateDB) GetNonce(addr common.Address) uint64 {
	if n, ok := s.nonceOverrides[addr]; ok {
		return n
	}
	var addr20 [20]byte
	copy(addr20[:], addr[:])
	acct, err := store.GetAccount(s.tx, s.db, addr20)
	if err != nil || acct == nil {
		return 0
	}
	return acct.Nonce
}

func (s *StateDB) SetNonce(addr common.Address, n uint64) {
	prev, had := s.nonceOverrides[addr]
	if !had {
		prev = s.GetNonce(addr)
		had = prev != 0
	}
	s.journal = append(s.journal, journalNonceChange{addr, prev, had})
	s.nonceOverrides[addr] = n
}

// ─── Code ──────────────────────────────────────────────────────────

func (s *StateDB) GetCode(addr common.Address) []byte {
	if code, ok := s.codeOverrides[addr]; ok {
		return append([]byte(nil), code...)
	}
	// Get account to find codeHash, then fetch code
	var addr20 [20]byte
	copy(addr20[:], addr[:])
	acct, err := store.GetAccount(s.tx, s.db, addr20)
	if err != nil || acct == nil {
		return nil
	}
	if acct.CodeHash == store.EmptyCodeHash || acct.CodeHash == [32]byte{} {
		return nil
	}
	code, err := store.GetCode(s.tx, s.db, acct.CodeHash)
	if err != nil {
		return nil
	}
	return code
}

func (s *StateDB) GetCodeHash(addr common.Address) common.Hash {
	if h, ok := s.codeHashCache[addr]; ok {
		return h
	}
	if code, ok := s.codeOverrides[addr]; ok {
		if len(code) == 0 {
			return common.Hash{}
		}
		h := crypto.Keccak256Hash(code)
		s.codeHashCache[addr] = h
		return h
	}
	var addr20 [20]byte
	copy(addr20[:], addr[:])
	acct, err := store.GetAccount(s.tx, s.db, addr20)
	if err != nil || acct == nil {
		return common.Hash{}
	}
	return common.Hash(acct.CodeHash)
}

func (s *StateDB) GetCodeSize(addr common.Address) int {
	return len(s.GetCode(addr))
}

func (s *StateDB) SetCode(addr common.Address, code []byte) {
	prev, had := s.codeOverrides[addr]
	if !had {
		prev = s.GetCode(addr)
		had = len(prev) > 0
	}
	s.journal = append(s.journal, journalCodeChange{addr: addr, prev: append([]byte(nil), prev...), had: had})
	s.codeOverrides[addr] = append([]byte(nil), code...)
	if len(code) > 0 {
		s.codeHashCache[addr] = crypto.Keccak256Hash(code)
	} else {
		delete(s.codeHashCache, addr)
	}
}

// ─── Account queries ───────────────────────────────────────────────

func (s *StateDB) Exist(addr common.Address) bool {
	if s.GetCodeSize(addr) > 0 {
		return true
	}
	if s.GetBalance(addr).Sign() > 0 {
		return true
	}
	if s.GetNonce(addr) > 0 {
		return true
	}
	return false
}

func (s *StateDB) Empty(addr common.Address) bool {
	return s.GetBalance(addr).IsZero() && s.GetNonce(addr) == 0 && s.GetCodeSize(addr) == 0
}

func (s *StateDB) CreateAccount(addr common.Address) {}

// ─── Self-destruct ─────────────────────────────────────────────────

func (s *StateDB) SelfDestruct(addr common.Address)           {}
func (s *StateDB) HasSelfDestructed(addr common.Address) bool { return false }
func (s *StateDB) Selfdestruct6780(addr common.Address)       {}

// ─── Snapshots ─────────────────────────────────────────────────────

func (s *StateDB) Snapshot() int {
	id := len(s.snapshots)
	s.snapshots = append(s.snapshots, len(s.journal))
	return id
}

func (s *StateDB) RevertToSnapshot(id int) {
	target := s.snapshots[id]
	s.snapshots = s.snapshots[:id]
	for i := len(s.journal) - 1; i >= target; i-- {
		s.journal[i].revert(s)
	}
	s.journal = s.journal[:target]
}

// ─── Refund ────────────────────────────────────────────────────────

func (s *StateDB) AddRefund(gas uint64) {
	s.journal = append(s.journal, journalRefundChange{s.refund})
	s.refund += gas
}

func (s *StateDB) SubRefund(gas uint64) {
	s.journal = append(s.journal, journalRefundChange{s.refund})
	s.refund -= gas
}

func (s *StateDB) GetRefund() uint64 { return s.refund }

// ─── Transient storage (EIP-1153) ──────────────────────────────────

func (s *StateDB) GetTransientState(addr common.Address, key common.Hash) common.Hash {
	if m, ok := s.transientStorage[addr]; ok {
		return m[key]
	}
	return common.Hash{}
}

func (s *StateDB) SetTransientState(addr common.Address, key, value common.Hash) {
	if _, ok := s.transientStorage[addr]; !ok {
		s.transientStorage[addr] = make(map[common.Hash]common.Hash)
	}
	s.transientStorage[addr][key] = value
}

// ─── Access list ───────────────────────────────────────────────────

func (s *StateDB) AddressInAccessList(addr common.Address) bool {
	_, ok := s.accessList[addr]
	return ok
}

func (s *StateDB) SlotInAccessList(addr common.Address, slot common.Hash) (bool, bool) {
	slots, addrOk := s.accessList[addr]
	if !addrOk {
		return false, false
	}
	_, slotOk := slots[slot]
	return true, slotOk
}

func (s *StateDB) AddAddressToAccessList(addr common.Address) {
	if _, ok := s.accessList[addr]; !ok {
		s.accessList[addr] = make(map[common.Hash]bool)
	}
}

func (s *StateDB) AddSlotToAccessList(addr common.Address, slot common.Hash) {
	s.AddAddressToAccessList(addr)
	s.accessList[addr][slot] = true
}

// ─── Logs ──────────────────────────────────────────────────────────

func (s *StateDB) AddLog(l *types.Log) {
	s.logs = append(s.logs, l)
}

func (s *StateDB) Logs() []*types.Log {
	return s.logs
}

func (s *StateDB) AddPreimage(hash common.Hash, data []byte) {}

// ─── Tx context ────────────────────────────────────────────────────

func (s *StateDB) SetTxContext(hash common.Hash, index int) {
	s.txHash = hash
	s.txIndex = index
}

func (s *StateDB) TxHash() common.Hash {
	return s.txHash
}

func (s *StateDB) TxIndex() int {
	return s.txIndex
}

// ─── Block hash ────────────────────────────────────────────────────

func (s *StateDB) GetBlockHash(num uint64) common.Hash {
	return common.Hash{}
}

// ─── Prepare ───────────────────────────────────────────────────────

func safeGetRulesExtra(rules params.Rules) predicate.Predicates {
	defer func() {
		if recover() != nil {
		}
	}()
	return cparams.GetRulesExtra(rules)
}

func (s *StateDB) Prepare(rules params.Rules, sender, coinbase common.Address, dest *common.Address, precompiles []common.Address, txAccesses types.AccessList) {
	s.accessList = make(map[common.Address]map[common.Hash]bool)
	s.predicates = make(map[common.Address][]predicate.Predicate)
	s.refund = 0
	s.logs = nil
	s.transientStorage = make(map[common.Address]map[common.Hash]common.Hash)

	if rulesExtra := safeGetRulesExtra(rules); rulesExtra != nil {
		s.predicates = predicate.FromAccessList(rulesExtra, txAccesses)
	}

	s.AddAddressToAccessList(sender)
	if dest != nil {
		s.AddAddressToAccessList(*dest)
	}
	s.AddAddressToAccessList(coinbase)
	for _, p := range precompiles {
		s.AddAddressToAccessList(p)
	}
	for _, el := range txAccesses {
		s.AddAddressToAccessList(el.Address)
		for _, key := range el.StorageKeys {
			s.AddSlotToAccessList(el.Address, key)
		}
	}
}

// ─── Predicates ────────────────────────────────────────────────────

func (s *StateDB) GetPredicate(address common.Address, index int) (predicate.Predicate, bool) {
	preds, exists := s.predicates[address]
	if !exists || index < 0 || index >= len(preds) {
		return nil, false
	}
	return preds[index], true
}

// ─── Multi-coin support ────────────────────────────────────────────

func normalizeCoinID(coinID *common.Hash) {
	coinID[0] |= 0x01
}

func (s *StateDB) GetBalanceMultiCoin(addr common.Address, coinID common.Hash) *big.Int {
	normalizeCoinID(&coinID)
	return s.GetState(addr, coinID, stateconf.SkipStateKeyTransformation()).Big()
}

func (s *StateDB) AddBalanceMultiCoin(addr common.Address, coinID common.Hash, amount *big.Int) {
	if amount == nil || amount.Sign() == 0 {
		return
	}
	newAmount := new(big.Int).Add(s.GetBalanceMultiCoin(addr, coinID), amount)
	normalizeCoinID(&coinID)
	s.SetState(addr, coinID, common.BigToHash(newAmount), stateconf.SkipStateKeyTransformation())
}

func (s *StateDB) SubBalanceMultiCoin(addr common.Address, coinID common.Hash, amount *big.Int) {
	if amount == nil || amount.Sign() == 0 {
		return
	}
	newAmount := new(big.Int).Sub(s.GetBalanceMultiCoin(addr, coinID), amount)
	normalizeCoinID(&coinID)
	s.SetState(addr, coinID, common.BigToHash(newAmount), stateconf.SkipStateKeyTransformation())
}

// ─── CollectChanges ────────────────────────────────────────────────

// StateChange represents a single state mutation from block execution.
type StateChange struct {
	Address   common.Address
	Slot      common.Hash // zero hash for account-level changes
	OldValue  [32]byte
	NewValue  [32]byte
	IsAccount bool // true for balance/nonce/code changes
}

// CollectChanges builds the changeset of all mutations relative to the MDBX base state.
func (s *StateDB) CollectChanges() []StateChange {
	var changes []StateChange

	// Storage changes
	for addr, slots := range s.storageOverrides {
		var addr20 [20]byte
		copy(addr20[:], addr[:])
		for slot, newVal := range slots {
			var slot32 [32]byte
			copy(slot32[:], slot[:])
			oldVal, _ := store.GetStorage(s.tx, s.db, addr20, slot32)
			changes = append(changes, StateChange{
				Address:  addr,
				Slot:     slot,
				OldValue: oldVal,
				NewValue: [32]byte(newVal),
			})
		}
	}

	// Balance changes
	for addr, newBal := range s.balanceOverrides {
		var addr20 [20]byte
		copy(addr20[:], addr[:])
		var oldValue [32]byte
		acct, err := store.GetAccount(s.tx, s.db, addr20)
		if err == nil && acct != nil {
			oldValue = acct.Balance
		}
		var newValue [32]byte
		newBal.WriteToArray32(&newValue)
		changes = append(changes, StateChange{
			Address:   addr,
			Slot:      common.Hash{},
			OldValue:  oldValue,
			NewValue:  newValue,
			IsAccount: true,
		})
	}

	// Nonce changes
	for addr, newNonce := range s.nonceOverrides {
		var addr20 [20]byte
		copy(addr20[:], addr[:])
		var oldValue [32]byte
		acct, err := store.GetAccount(s.tx, s.db, addr20)
		if err == nil && acct != nil {
			oldValue[24] = byte(acct.Nonce >> 56)
			oldValue[25] = byte(acct.Nonce >> 48)
			oldValue[26] = byte(acct.Nonce >> 40)
			oldValue[27] = byte(acct.Nonce >> 32)
			oldValue[28] = byte(acct.Nonce >> 24)
			oldValue[29] = byte(acct.Nonce >> 16)
			oldValue[30] = byte(acct.Nonce >> 8)
			oldValue[31] = byte(acct.Nonce)
		}
		var newValue [32]byte
		newValue[24] = byte(newNonce >> 56)
		newValue[25] = byte(newNonce >> 48)
		newValue[26] = byte(newNonce >> 40)
		newValue[27] = byte(newNonce >> 32)
		newValue[28] = byte(newNonce >> 24)
		newValue[29] = byte(newNonce >> 16)
		newValue[30] = byte(newNonce >> 8)
		newValue[31] = byte(newNonce)
		changes = append(changes, StateChange{
			Address:   addr,
			Slot:      common.Hash{},
			OldValue:  oldValue,
			NewValue:  newValue,
			IsAccount: true,
		})
	}

	// Code changes
	for addr, newCode := range s.codeOverrides {
		var addr20 [20]byte
		copy(addr20[:], addr[:])
		var oldValue [32]byte
		acct, err := store.GetAccount(s.tx, s.db, addr20)
		if err == nil && acct != nil {
			oldValue = acct.CodeHash
		}
		var newValue [32]byte
		if len(newCode) > 0 {
			h := crypto.Keccak256Hash(newCode)
			copy(newValue[:], h[:])
		}
		changes = append(changes, StateChange{
			Address:   addr,
			Slot:      common.Hash{},
			OldValue:  oldValue,
			NewValue:  newValue,
			IsAccount: true,
		})
	}

	return changes
}

// GetBalanceOverride returns the balance override for an address, or nil if none.
func (s *StateDB) GetBalanceOverride(addr common.Address) *uint256.Int {
	if bal, ok := s.balanceOverrides[addr]; ok {
		return bal
	}
	return nil
}

// GetNonceOverride returns the nonce override for an address.
func (s *StateDB) GetNonceOverride(addr common.Address) (uint64, bool) {
	n, ok := s.nonceOverrides[addr]
	return n, ok
}

// GetCodeOverride returns the code override for an address.
func (s *StateDB) GetCodeOverride(addr common.Address) ([]byte, bool) {
	code, ok := s.codeOverrides[addr]
	return code, ok
}
