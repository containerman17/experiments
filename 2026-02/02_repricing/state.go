package main

import (
	"math/big"

	"github.com/ava-labs/avalanchego/vms/evm/predicate"
	"github.com/ava-labs/libevm/common"
	"github.com/ava-labs/libevm/core/types"
	"github.com/ava-labs/libevm/crypto"
	"github.com/ava-labs/libevm/libevm/stateconf"
	"github.com/ava-labs/libevm/params"
	"github.com/holiman/uint256"
)

// ReplayState implements vm.StateDB for block replay.
//
// Layers:
//   - base: RPC-backed lazy loading at parent block number
//   - dirty: accumulated writes from committed txs in this block
//   - tx: current tx writes with journal for snapshot/revert
//
// Read order:
//   - GetState:          tx -> dirty -> base
//   - GetCommittedState: dirty -> base (never tx — EIP-2200 "original" value)
type ReplayState struct {
	rpc *RPCClient

	// Dirty layer: committed writes from prior txs
	dirtyStorage  map[common.Address]map[common.Hash]common.Hash
	dirtyBalance  map[common.Address]*uint256.Int
	dirtyNonce    map[common.Address]uint64
	dirtyCode     map[common.Address][]byte
	dirtyCodeHash map[common.Address]common.Hash
	dirtyExist    map[common.Address]bool
	dirtySuicided map[common.Address]bool

	// TX layer: current tx writes (journaled)
	txStorage  map[common.Address]map[common.Hash]common.Hash
	txBalance  map[common.Address]*uint256.Int
	txNonce    map[common.Address]uint64
	txCode     map[common.Address][]byte
	txCodeHash map[common.Address]common.Hash
	txExist    map[common.Address]bool
	txSuicided map[common.Address]bool

	// Access list (per-tx, reset in Prepare)
	accessedAddrs map[common.Address]bool
	accessedSlots map[common.Address]map[common.Hash]bool

	// Transient storage (per-tx, EIP-1153)
	transient map[common.Address]map[common.Hash]common.Hash

	// Refund counter
	refund uint64

	// Logs
	logs    []*types.Log
	txHash  common.Hash
	txIndex int

	// Journal for snapshot/revert within a tx
	journal   []func()
	snapshots []int
}

func NewReplayState(rpc *RPCClient) *ReplayState {
	return &ReplayState{
		rpc:           rpc,
		dirtyStorage:  make(map[common.Address]map[common.Hash]common.Hash),
		dirtyBalance:  make(map[common.Address]*uint256.Int),
		dirtyNonce:    make(map[common.Address]uint64),
		dirtyCode:     make(map[common.Address][]byte),
		dirtyCodeHash: make(map[common.Address]common.Hash),
		dirtyExist:    make(map[common.Address]bool),
		dirtySuicided: make(map[common.Address]bool),
		txStorage:     make(map[common.Address]map[common.Hash]common.Hash),
		txBalance:     make(map[common.Address]*uint256.Int),
		txNonce:       make(map[common.Address]uint64),
		txCode:        make(map[common.Address][]byte),
		txCodeHash:    make(map[common.Address]common.Hash),
		txExist:       make(map[common.Address]bool),
		txSuicided:    make(map[common.Address]bool),
		accessedAddrs: make(map[common.Address]bool),
		accessedSlots: make(map[common.Address]map[common.Hash]bool),
		transient:     make(map[common.Address]map[common.Hash]common.Hash),
	}
}

// BeginTx clears per-tx state for a new transaction.
func (s *ReplayState) BeginTx(txHash common.Hash, txIndex int) {
	s.txStorage = make(map[common.Address]map[common.Hash]common.Hash)
	s.txBalance = make(map[common.Address]*uint256.Int)
	s.txNonce = make(map[common.Address]uint64)
	s.txCode = make(map[common.Address][]byte)
	s.txCodeHash = make(map[common.Address]common.Hash)
	s.txExist = make(map[common.Address]bool)
	s.txSuicided = make(map[common.Address]bool)
	s.accessedAddrs = make(map[common.Address]bool)
	s.accessedSlots = make(map[common.Address]map[common.Hash]bool)
	s.transient = make(map[common.Address]map[common.Hash]common.Hash)
	s.refund = 0
	s.logs = nil
	s.journal = s.journal[:0]
	s.snapshots = s.snapshots[:0]
	s.txHash = txHash
	s.txIndex = txIndex
}

// CommitTx merges tx writes into the dirty layer.
func (s *ReplayState) CommitTx() {
	// Storage
	for addr, slots := range s.txStorage {
		if s.dirtyStorage[addr] == nil {
			s.dirtyStorage[addr] = make(map[common.Hash]common.Hash)
		}
		for k, v := range slots {
			s.dirtyStorage[addr][k] = v
		}
	}
	// Balance
	for addr, bal := range s.txBalance {
		s.dirtyBalance[addr] = bal.Clone()
	}
	// Nonce
	for addr, n := range s.txNonce {
		s.dirtyNonce[addr] = n
	}
	// Code
	for addr, code := range s.txCode {
		s.dirtyCode[addr] = code
		s.dirtyCodeHash[addr] = crypto.Keccak256Hash(code)
	}
	// Existence
	for addr, v := range s.txExist {
		s.dirtyExist[addr] = v
	}
	// Self-destruct: zero balance
	for addr, v := range s.txSuicided {
		if v {
			s.dirtySuicided[addr] = true
			s.dirtyBalance[addr] = uint256.NewInt(0)
		}
	}
}

// ---- vm.StateDB: Storage ----

func (s *ReplayState) GetState(addr common.Address, key common.Hash, _ ...stateconf.StateDBStateOption) common.Hash {
	// TX layer first
	if slots, ok := s.txStorage[addr]; ok {
		if val, ok := slots[key]; ok {
			return val
		}
	}
	return s.getCommittedStorage(addr, key)
}

func (s *ReplayState) GetCommittedState(addr common.Address, key common.Hash, _ ...stateconf.StateDBStateOption) common.Hash {
	// Never include tx layer — this is "original" for EIP-2200
	return s.getCommittedStorage(addr, key)
}

func (s *ReplayState) getCommittedStorage(addr common.Address, key common.Hash) common.Hash {
	// Dirty layer
	if slots, ok := s.dirtyStorage[addr]; ok {
		if val, ok := slots[key]; ok {
			return val
		}
	}
	// Base (RPC)
	return s.rpc.FetchStorage(addr, key)
}

func (s *ReplayState) SetState(addr common.Address, key, value common.Hash, _ ...stateconf.StateDBStateOption) {
	// Journal the old tx value
	var prev common.Hash
	var had bool
	if slots, ok := s.txStorage[addr]; ok {
		prev, had = slots[key]
	}
	s.addJournal(func() {
		if !had {
			delete(s.txStorage[addr], key)
		} else {
			s.txStorage[addr][key] = prev
		}
	})
	if s.txStorage[addr] == nil {
		s.txStorage[addr] = make(map[common.Hash]common.Hash)
	}
	s.txStorage[addr][key] = value
}

// ---- vm.StateDB: Balance ----

func (s *ReplayState) GetBalance(addr common.Address) *uint256.Int {
	if bal, ok := s.txBalance[addr]; ok {
		return bal.Clone()
	}
	if bal, ok := s.dirtyBalance[addr]; ok {
		return bal.Clone()
	}
	return s.rpc.FetchBalance(addr).Clone()
}

func (s *ReplayState) AddBalance(addr common.Address, amount *uint256.Int) {
	prev := s.GetBalance(addr)
	s.addJournal(func() { s.txBalance[addr] = prev })
	s.txBalance[addr] = new(uint256.Int).Add(prev, amount)
}

func (s *ReplayState) SubBalance(addr common.Address, amount *uint256.Int) {
	prev := s.GetBalance(addr)
	s.addJournal(func() { s.txBalance[addr] = prev })
	s.txBalance[addr] = new(uint256.Int).Sub(prev, amount)
}

// ---- vm.StateDB: Nonce ----

func (s *ReplayState) GetNonce(addr common.Address) uint64 {
	if n, ok := s.txNonce[addr]; ok {
		return n
	}
	if n, ok := s.dirtyNonce[addr]; ok {
		return n
	}
	return s.rpc.FetchNonce(addr)
}

func (s *ReplayState) SetNonce(addr common.Address, nonce uint64) {
	prev := s.GetNonce(addr)
	prevOk := false
	if _, ok := s.txNonce[addr]; ok {
		prevOk = true
	}
	s.addJournal(func() {
		if !prevOk {
			delete(s.txNonce, addr)
		} else {
			s.txNonce[addr] = prev
		}
	})
	s.txNonce[addr] = nonce
}

// ---- vm.StateDB: Code ----

func (s *ReplayState) GetCode(addr common.Address) []byte {
	if code, ok := s.txCode[addr]; ok {
		return code
	}
	if code, ok := s.dirtyCode[addr]; ok {
		return code
	}
	return s.rpc.FetchCode(addr)
}

func (s *ReplayState) GetCodeSize(addr common.Address) int {
	return len(s.GetCode(addr))
}

func (s *ReplayState) GetCodeHash(addr common.Address) common.Hash {
	if hash, ok := s.txCodeHash[addr]; ok {
		return hash
	}
	if hash, ok := s.dirtyCodeHash[addr]; ok {
		return hash
	}
	code := s.rpc.FetchCode(addr)
	if len(code) == 0 {
		return types.EmptyCodeHash
	}
	return crypto.Keccak256Hash(code)
}

func (s *ReplayState) SetCode(addr common.Address, code []byte) {
	prevCode, hadCode := s.txCode[addr]
	prevHash, hadHash := s.txCodeHash[addr]
	s.addJournal(func() {
		if !hadCode {
			delete(s.txCode, addr)
		} else {
			s.txCode[addr] = prevCode
		}
		if !hadHash {
			delete(s.txCodeHash, addr)
		} else {
			s.txCodeHash[addr] = prevHash
		}
	})
	s.txCode[addr] = code
	if len(code) > 0 {
		s.txCodeHash[addr] = crypto.Keccak256Hash(code)
	} else {
		s.txCodeHash[addr] = common.Hash{}
	}
}

// ---- vm.StateDB: Account ----

func (s *ReplayState) CreateAccount(addr common.Address) {
	prev, had := s.txExist[addr]
	s.addJournal(func() {
		if !had {
			delete(s.txExist, addr)
		} else {
			s.txExist[addr] = prev
		}
	})
	s.txExist[addr] = true
}

func (s *ReplayState) Exist(addr common.Address) bool {
	if v, ok := s.txExist[addr]; ok {
		return v
	}
	if v, ok := s.dirtyExist[addr]; ok {
		return v
	}
	// Account exists if it has code or non-zero balance or non-zero nonce
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

func (s *ReplayState) Empty(addr common.Address) bool {
	return s.GetNonce(addr) == 0 && s.GetBalance(addr).Sign() == 0 && s.GetCodeSize(addr) == 0
}

// ---- vm.StateDB: Self-destruct ----

func (s *ReplayState) SelfDestruct(addr common.Address) {
	prevBal := s.GetBalance(addr)
	prevSuicided, hadSuicided := s.txSuicided[addr]
	s.addJournal(func() {
		s.txBalance[addr] = prevBal
		if !hadSuicided {
			delete(s.txSuicided, addr)
		} else {
			s.txSuicided[addr] = prevSuicided
		}
	})
	s.txBalance[addr] = uint256.NewInt(0)
	s.txSuicided[addr] = true
}

func (s *ReplayState) HasSelfDestructed(addr common.Address) bool {
	if v, ok := s.txSuicided[addr]; ok {
		return v
	}
	return s.dirtySuicided[addr]
}

func (s *ReplayState) Selfdestruct6780(addr common.Address) {
	// EIP-6780: only self-destruct if created in same tx
	if s.txExist[addr] {
		s.SelfDestruct(addr)
	}
}

// ---- vm.StateDB: Access list ----

func (s *ReplayState) AddressInAccessList(addr common.Address) bool {
	return s.accessedAddrs[addr]
}

func (s *ReplayState) SlotInAccessList(addr common.Address, slot common.Hash) (addressOk bool, slotOk bool) {
	addressOk = s.accessedAddrs[addr]
	if slots, ok := s.accessedSlots[addr]; ok {
		slotOk = slots[slot]
	}
	return
}

func (s *ReplayState) AddAddressToAccessList(addr common.Address) {
	if !s.accessedAddrs[addr] {
		s.addJournal(func() { delete(s.accessedAddrs, addr) })
	}
	s.accessedAddrs[addr] = true
}

func (s *ReplayState) AddSlotToAccessList(addr common.Address, slot common.Hash) {
	hadAddr := s.accessedAddrs[addr]
	hadSlot := false
	if slots, ok := s.accessedSlots[addr]; ok {
		hadSlot = slots[slot]
	}
	if !hadSlot {
		s.addJournal(func() {
			if slots, ok := s.accessedSlots[addr]; ok {
				delete(slots, slot)
				if len(slots) == 0 {
					delete(s.accessedSlots, addr)
				}
			}
			if !hadAddr {
				delete(s.accessedAddrs, addr)
			}
		})
	}
	s.accessedAddrs[addr] = true
	if s.accessedSlots[addr] == nil {
		s.accessedSlots[addr] = make(map[common.Hash]bool)
	}
	s.accessedSlots[addr][slot] = true
}

func (s *ReplayState) Prepare(rules params.Rules, sender, coinbase common.Address, dest *common.Address, precompiles []common.Address, txAccesses types.AccessList) {
	if rules.IsBerlin {
		s.accessedAddrs = make(map[common.Address]bool)
		s.accessedSlots = make(map[common.Address]map[common.Hash]bool)

		s.accessedAddrs[sender] = true
		if dest != nil {
			s.accessedAddrs[*dest] = true
		}
		for _, addr := range precompiles {
			s.accessedAddrs[addr] = true
		}
		for _, el := range txAccesses {
			s.accessedAddrs[el.Address] = true
			for _, slot := range el.StorageKeys {
				if s.accessedSlots[el.Address] == nil {
					s.accessedSlots[el.Address] = make(map[common.Hash]bool)
				}
				s.accessedSlots[el.Address][slot] = true
			}
		}
		if rules.IsShanghai {
			s.accessedAddrs[coinbase] = true
		}
	}
	s.transient = make(map[common.Address]map[common.Hash]common.Hash)
}

// ---- vm.StateDB: Transient storage ----

func (s *ReplayState) GetTransientState(addr common.Address, key common.Hash) common.Hash {
	if slots, ok := s.transient[addr]; ok {
		return slots[key]
	}
	return common.Hash{}
}

func (s *ReplayState) SetTransientState(addr common.Address, key, value common.Hash) {
	var prev common.Hash
	var had bool
	if slots, ok := s.transient[addr]; ok {
		prev, had = slots[key]
	}
	s.addJournal(func() {
		if !had {
			delete(s.transient[addr], key)
		} else {
			s.transient[addr][key] = prev
		}
	})
	if s.transient[addr] == nil {
		s.transient[addr] = make(map[common.Hash]common.Hash)
	}
	s.transient[addr][key] = value
}

// ---- vm.StateDB: Refund ----

func (s *ReplayState) AddRefund(gas uint64) {
	prev := s.refund
	s.addJournal(func() { s.refund = prev })
	s.refund += gas
}

func (s *ReplayState) SubRefund(gas uint64) {
	prev := s.refund
	s.addJournal(func() { s.refund = prev })
	if gas > s.refund {
		panic("refund counter below zero")
	}
	s.refund -= gas
}

func (s *ReplayState) GetRefund() uint64 {
	return s.refund
}

// ---- vm.StateDB: Logs ----

func (s *ReplayState) AddLog(log *types.Log) {
	prevLen := len(s.logs)
	s.addJournal(func() { s.logs = s.logs[:prevLen] })
	log.TxHash = s.txHash
	log.TxIndex = uint(s.txIndex)
	log.Index = uint(prevLen)
	s.logs = append(s.logs, log)
}

func (s *ReplayState) GetLogs() []*types.Log {
	return s.logs
}

func (s *ReplayState) Logs() []*types.Log {
	return s.logs
}

// ---- vm.StateDB: Misc ----

func (s *ReplayState) AddPreimage(hash common.Hash, preimage []byte) {}

// ---- vm.StateDB: Snapshot/Revert ----

func (s *ReplayState) Snapshot() int {
	id := len(s.snapshots)
	s.snapshots = append(s.snapshots, len(s.journal))
	return id
}

func (s *ReplayState) RevertToSnapshot(id int) {
	target := s.snapshots[id]
	s.snapshots = s.snapshots[:id]
	for i := len(s.journal) - 1; i >= target; i-- {
		s.journal[i]()
	}
	s.journal = s.journal[:target]
}

func (s *ReplayState) addJournal(revert func()) {
	s.journal = append(s.journal, revert)
}

// ---- Not in vm.StateDB interface but called by some code paths ----

func (s *ReplayState) TxHash() common.Hash { return s.txHash }
func (s *ReplayState) TxIndex() int        { return s.txIndex }

func (s *ReplayState) GetPredicate(common.Address, int) (predicate.Predicate, bool) {
	return nil, false
}

func (s *ReplayState) GetBalanceMultiCoin(addr common.Address, coinID common.Hash) *big.Int {
	normalizeCoinID(&coinID)
	return s.GetState(addr, coinID).Big()
}

func (s *ReplayState) AddBalanceMultiCoin(addr common.Address, coinID common.Hash, amount *big.Int) {
	if amount.Sign() == 0 {
		return
	}
	normalizeCoinID(&coinID)
	newAmount := new(big.Int).Add(s.GetBalanceMultiCoin(addr, coinID), amount)
	s.SetState(addr, coinID, common.BigToHash(newAmount))
}

func (s *ReplayState) SubBalanceMultiCoin(addr common.Address, coinID common.Hash, amount *big.Int) {
	if amount.Sign() == 0 {
		return
	}
	normalizeCoinID(&coinID)
	newAmount := new(big.Int).Sub(s.GetBalanceMultiCoin(addr, coinID), amount)
	s.SetState(addr, coinID, common.BigToHash(newAmount))
}

func normalizeCoinID(coinID *common.Hash) {
	coinID[0] |= 0x01
}

// Unused but needed to satisfy some callers
func ptrU64(v uint64) *uint64    { return &v }
func ptrBigInt(v int64) *big.Int { return big.NewInt(v) }
