package lightnode

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
var _ vm.StateDB = (*historicalState)(nil)

// historicalState implements vm.StateDB for read-only historical state queries.
// All read methods use LookupHistorical* functions; write methods are no-ops
// (with minimal journal support for snapshot/revert used by the EVM).
type historicalState struct {
	tx       *mdbx.Txn
	db       *store.DB
	blockNum uint64

	// Write overlay (needed for EVM execution of eth_call)
	storageOverrides map[common.Address]map[common.Hash]common.Hash
	balanceOverrides map[common.Address]*uint256.Int
	nonceOverrides   map[common.Address]uint64
	codeOverrides    map[common.Address][]byte
	codeHashCache    map[common.Address]common.Hash

	// Journal for snapshot/revert
	journal   []histJournalEntry
	snapshots []int

	// EVM per-tx state
	accessList       map[common.Address]map[common.Hash]bool
	refund           uint64
	logs             []*types.Log
	txHash           common.Hash
	txIndex          int
	transientStorage map[common.Address]map[common.Hash]common.Hash
	predicates       map[common.Address][]predicate.Predicate
}

func newHistoricalState(tx *mdbx.Txn, db *store.DB, blockNum uint64) *historicalState {
	return &historicalState{
		tx:               tx,
		db:               db,
		blockNum:         blockNum,
		storageOverrides: make(map[common.Address]map[common.Hash]common.Hash),
		balanceOverrides: make(map[common.Address]*uint256.Int),
		nonceOverrides:   make(map[common.Address]uint64),
		codeOverrides:    make(map[common.Address][]byte),
		codeHashCache:    make(map[common.Address]common.Hash),
		accessList:       make(map[common.Address]map[common.Hash]bool),
		transientStorage: make(map[common.Address]map[common.Hash]common.Hash),
		predicates:       make(map[common.Address][]predicate.Predicate),
	}
}

// ─── Journal entries ──────────────────────────────────────────────

type histJournalEntry interface {
	revert(s *historicalState)
}

type histStorageChange struct {
	addr common.Address
	key  common.Hash
	prev common.Hash
	had  bool
}

func (j histStorageChange) revert(s *historicalState) {
	if !j.had {
		delete(s.storageOverrides[j.addr], j.key)
		if len(s.storageOverrides[j.addr]) == 0 {
			delete(s.storageOverrides, j.addr)
		}
	} else {
		s.storageOverrides[j.addr][j.key] = j.prev
	}
}

type histBalanceChange struct {
	addr common.Address
	prev *uint256.Int
	had  bool
}

func (j histBalanceChange) revert(s *historicalState) {
	if !j.had {
		delete(s.balanceOverrides, j.addr)
	} else {
		s.balanceOverrides[j.addr] = j.prev
	}
}

type histNonceChange struct {
	addr common.Address
	prev uint64
	had  bool
}

func (j histNonceChange) revert(s *historicalState) {
	if !j.had {
		delete(s.nonceOverrides, j.addr)
	} else {
		s.nonceOverrides[j.addr] = j.prev
	}
}

type histCodeChange struct {
	addr common.Address
	prev []byte
	had  bool
}

func (j histCodeChange) revert(s *historicalState) {
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

type histRefundChange struct {
	prev uint64
}

func (j histRefundChange) revert(s *historicalState) {
	s.refund = j.prev
}

// ─── Historical account helper ────────────────────────────────────

func (s *historicalState) getHistoricalAccount(addr common.Address) *store.Account {
	var addr20 [20]byte
	copy(addr20[:], addr[:])
	acct, _ := store.LookupHistoricalAccount(s.tx, s.db, addr20, s.blockNum)
	return acct
}

// ─── Storage ──────────────────────────────────────────────────────

func (s *historicalState) GetState(addr common.Address, key common.Hash, _ ...stateconf.StateDBStateOption) common.Hash {
	if slots, ok := s.storageOverrides[addr]; ok {
		if val, ok := slots[key]; ok {
			return val
		}
	}
	var addr20 [20]byte
	var slot32 [32]byte
	copy(addr20[:], addr[:])
	copy(slot32[:], key[:])
	val, err := store.LookupHistoricalStorage(s.tx, s.db, addr20, slot32, s.blockNum)
	if err != nil {
		return common.Hash{}
	}
	return common.Hash(val)
}

func (s *historicalState) GetCommittedState(addr common.Address, key common.Hash, _ ...stateconf.StateDBStateOption) common.Hash {
	var addr20 [20]byte
	var slot32 [32]byte
	copy(addr20[:], addr[:])
	copy(slot32[:], key[:])
	val, err := store.LookupHistoricalStorage(s.tx, s.db, addr20, slot32, s.blockNum)
	if err != nil {
		return common.Hash{}
	}
	return common.Hash(val)
}

func (s *historicalState) SetState(addr common.Address, key, value common.Hash, _ ...stateconf.StateDBStateOption) {
	var prev common.Hash
	var had bool
	if slots, ok := s.storageOverrides[addr]; ok {
		prev, had = slots[key]
	}
	s.journal = append(s.journal, histStorageChange{addr, key, prev, had})
	if s.storageOverrides[addr] == nil {
		s.storageOverrides[addr] = make(map[common.Hash]common.Hash)
	}
	s.storageOverrides[addr][key] = value
}

// ─── Balance ──────────────────────────────────────────────────────

func (s *historicalState) GetBalance(addr common.Address) *uint256.Int {
	if bal, ok := s.balanceOverrides[addr]; ok {
		return new(uint256.Int).Set(bal)
	}
	acct := s.getHistoricalAccount(addr)
	if acct == nil {
		return uint256.NewInt(0)
	}
	return new(uint256.Int).SetBytes32(acct.Balance[:])
}

func (s *historicalState) SubBalance(addr common.Address, amount *uint256.Int) {
	prev, had := s.balanceOverrides[addr]
	if had {
		prev = prev.Clone()
	}
	s.journal = append(s.journal, histBalanceChange{addr, prev, had})
	bal := s.GetBalance(addr)
	s.balanceOverrides[addr] = new(uint256.Int).Sub(bal, amount)
}

func (s *historicalState) AddBalance(addr common.Address, amount *uint256.Int) {
	prev, had := s.balanceOverrides[addr]
	if had {
		prev = prev.Clone()
	}
	s.journal = append(s.journal, histBalanceChange{addr, prev, had})
	bal := s.GetBalance(addr)
	s.balanceOverrides[addr] = new(uint256.Int).Add(bal, amount)
}

// ─── Nonce ────────────────────────────────────────────────────────

func (s *historicalState) GetNonce(addr common.Address) uint64 {
	if n, ok := s.nonceOverrides[addr]; ok {
		return n
	}
	acct := s.getHistoricalAccount(addr)
	if acct == nil {
		return 0
	}
	return acct.Nonce
}

func (s *historicalState) SetNonce(addr common.Address, n uint64) {
	prev, had := s.nonceOverrides[addr]
	if !had {
		prev = s.GetNonce(addr)
		had = prev != 0
	}
	s.journal = append(s.journal, histNonceChange{addr, prev, had})
	s.nonceOverrides[addr] = n
}

// ─── Code ─────────────────────────────────────────────────────────

func (s *historicalState) GetCode(addr common.Address) []byte {
	if code, ok := s.codeOverrides[addr]; ok {
		return append([]byte(nil), code...)
	}
	// Code is immutable per codeHash. We look up the historical account to get
	// the codeHash, then fetch code from the current code table.
	acct := s.getHistoricalAccount(addr)
	if acct == nil {
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

func (s *historicalState) GetCodeHash(addr common.Address) common.Hash {
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
	acct := s.getHistoricalAccount(addr)
	if acct == nil {
		return common.Hash{}
	}
	return common.Hash(acct.CodeHash)
}

func (s *historicalState) GetCodeSize(addr common.Address) int {
	return len(s.GetCode(addr))
}

func (s *historicalState) SetCode(addr common.Address, code []byte) {
	prev, had := s.codeOverrides[addr]
	if !had {
		prev = s.GetCode(addr)
		had = len(prev) > 0
	}
	s.journal = append(s.journal, histCodeChange{addr: addr, prev: append([]byte(nil), prev...), had: had})
	s.codeOverrides[addr] = append([]byte(nil), code...)
	if len(code) > 0 {
		s.codeHashCache[addr] = crypto.Keccak256Hash(code)
	} else {
		delete(s.codeHashCache, addr)
	}
}

// ─── Account queries ──────────────────────────────────────────────

func (s *historicalState) Exist(addr common.Address) bool {
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

func (s *historicalState) Empty(addr common.Address) bool {
	return s.GetBalance(addr).IsZero() && s.GetNonce(addr) == 0 && s.GetCodeSize(addr) == 0
}

func (s *historicalState) CreateAccount(addr common.Address) {}

// ─── Self-destruct ────────────────────────────────────────────────

func (s *historicalState) SelfDestruct(addr common.Address)           {}
func (s *historicalState) HasSelfDestructed(addr common.Address) bool { return false }
func (s *historicalState) Selfdestruct6780(addr common.Address)       {}

// ─── Snapshots ────────────────────────────────────────────────────

func (s *historicalState) Snapshot() int {
	id := len(s.snapshots)
	s.snapshots = append(s.snapshots, len(s.journal))
	return id
}

func (s *historicalState) RevertToSnapshot(id int) {
	target := s.snapshots[id]
	s.snapshots = s.snapshots[:id]
	for i := len(s.journal) - 1; i >= target; i-- {
		s.journal[i].revert(s)
	}
	s.journal = s.journal[:target]
}

// ─── Refund ───────────────────────────────────────────────────────

func (s *historicalState) AddRefund(gas uint64) {
	s.journal = append(s.journal, histRefundChange{s.refund})
	s.refund += gas
}

func (s *historicalState) SubRefund(gas uint64) {
	s.journal = append(s.journal, histRefundChange{s.refund})
	s.refund -= gas
}

func (s *historicalState) GetRefund() uint64 { return s.refund }

// ─── Transient storage (EIP-1153) ─────────────────────────────────

func (s *historicalState) GetTransientState(addr common.Address, key common.Hash) common.Hash {
	if m, ok := s.transientStorage[addr]; ok {
		return m[key]
	}
	return common.Hash{}
}

func (s *historicalState) SetTransientState(addr common.Address, key, value common.Hash) {
	if _, ok := s.transientStorage[addr]; !ok {
		s.transientStorage[addr] = make(map[common.Hash]common.Hash)
	}
	s.transientStorage[addr][key] = value
}

// ─── Access list ──────────────────────────────────────────────────

func (s *historicalState) AddressInAccessList(addr common.Address) bool {
	_, ok := s.accessList[addr]
	return ok
}

func (s *historicalState) SlotInAccessList(addr common.Address, slot common.Hash) (bool, bool) {
	slots, addrOk := s.accessList[addr]
	if !addrOk {
		return false, false
	}
	_, slotOk := slots[slot]
	return true, slotOk
}

func (s *historicalState) AddAddressToAccessList(addr common.Address) {
	if _, ok := s.accessList[addr]; !ok {
		s.accessList[addr] = make(map[common.Hash]bool)
	}
}

func (s *historicalState) AddSlotToAccessList(addr common.Address, slot common.Hash) {
	s.AddAddressToAccessList(addr)
	s.accessList[addr][slot] = true
}

// ─── Logs ─────────────────────────────────────────────────────────

func (s *historicalState) AddLog(l *types.Log) {
	s.logs = append(s.logs, l)
}

func (s *historicalState) Logs() []*types.Log {
	return s.logs
}

func (s *historicalState) AddPreimage(hash common.Hash, data []byte) {}

// ─── Tx context ───────────────────────────────────────────────────

func (s *historicalState) SetTxContext(hash common.Hash, index int) {
	s.txHash = hash
	s.txIndex = index
}

func (s *historicalState) TxHash() common.Hash   { return s.txHash }
func (s *historicalState) TxIndex() int           { return s.txIndex }

// ─── Block hash ───────────────────────────────────────────────────

func (s *historicalState) GetBlockHash(num uint64) common.Hash {
	return common.Hash{}
}

// ─── Prepare ──────────────────────────────────────────────────────

func safeGetRulesExtra(rules params.Rules) predicate.Predicates {
	defer func() {
		if recover() != nil {
		}
	}()
	return cparams.GetRulesExtra(rules)
}

func (s *historicalState) Prepare(rules params.Rules, sender, coinbase common.Address, dest *common.Address, precompiles []common.Address, txAccesses types.AccessList) {
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

// ─── Predicates ───────────────────────────────────────────────────

func (s *historicalState) GetPredicate(address common.Address, index int) (predicate.Predicate, bool) {
	preds, exists := s.predicates[address]
	if !exists || index < 0 || index >= len(preds) {
		return nil, false
	}
	return preds[index], true
}

// ─── Multi-coin support ───────────────────────────────────────────

func normalizeCoinID(coinID *common.Hash) {
	coinID[0] |= 0x01
}

func (s *historicalState) GetBalanceMultiCoin(addr common.Address, coinID common.Hash) *big.Int {
	normalizeCoinID(&coinID)
	return s.GetState(addr, coinID, stateconf.SkipStateKeyTransformation()).Big()
}

func (s *historicalState) AddBalanceMultiCoin(addr common.Address, coinID common.Hash, amount *big.Int) {
	if amount == nil || amount.Sign() == 0 {
		return
	}
	newAmount := new(big.Int).Add(s.GetBalanceMultiCoin(addr, coinID), amount)
	normalizeCoinID(&coinID)
	s.SetState(addr, coinID, common.BigToHash(newAmount), stateconf.SkipStateKeyTransformation())
}

func (s *historicalState) SubBalanceMultiCoin(addr common.Address, coinID common.Hash, amount *big.Int) {
	if amount == nil || amount.Sign() == 0 {
		return
	}
	newAmount := new(big.Int).Sub(s.GetBalanceMultiCoin(addr, coinID), amount)
	normalizeCoinID(&coinID)
	s.SetState(addr, coinID, common.BigToHash(newAmount), stateconf.SkipStateKeyTransformation())
}
