package executor

import (
	"fmt"
	"log"
	"math/big"
	"runtime"

	corethcore "github.com/ava-labs/avalanchego/graft/coreth/core"
	cparams "github.com/ava-labs/avalanchego/graft/coreth/params"
	"github.com/ava-labs/avalanchego/graft/coreth/plugin/evm/atomic"
	ccustomtypes "github.com/ava-labs/avalanchego/graft/coreth/plugin/evm/customtypes"
	"github.com/ava-labs/avalanchego/ids"
	"github.com/ava-labs/avalanchego/snow"
	proposerblock "github.com/ava-labs/avalanchego/vms/proposervm/block"
	"github.com/ava-labs/libevm/common"
	"github.com/ava-labs/libevm/core/types"
	"github.com/ava-labs/libevm/core/vm"
	"github.com/ava-labs/libevm/crypto"
	"github.com/ava-labs/libevm/params"
	"github.com/ava-labs/libevm/rlp"

	"github.com/erigontech/mdbx-go/mdbx"

	"block_fetcher/store"
	"block_fetcher/trie"
)

// NOTE: cparams.RegisterExtras() and ccustomtypes.Register() must be called
// once by the main package before using the executor.

// MainnetAVAXAssetID is the CB58-encoded asset ID for AVAX on mainnet.
const MainnetAVAXAssetID = "FvwEAhmxKfeiG8SnEvq42hc6whRyY3EFYAvebMqDNDGCgxN5Z"

// Executor reads raw blocks from MDBX, executes them via the EVM,
// writes state changes, and records history.
type Executor struct {
	db       *store.DB
	chainCfg *params.ChainConfig
	snowCtx  *snow.Context
}

// NewExecutor creates a new Executor.
func NewExecutor(db *store.DB, chainCfg *params.ChainConfig) *Executor {
	avaxAssetID, err := ids.FromString(MainnetAVAXAssetID)
	if err != nil {
		panic(fmt.Sprintf("invalid AVAX asset ID: %v", err))
	}

	return &Executor{
		db:       db,
		chainCfg: chainCfg,
		snowCtx: &snow.Context{
			AVAXAssetID: avaxAssetID,
		},
	}
}

// parseEthBlock decodes a raw block from MDBX. It first tries to unwrap a
// ProposerVM envelope; if that fails it falls back to a pre-fork RLP decode.
func parseEthBlock(raw []byte) (*types.Block, error) {
	// Try ProposerVM wrapped block first.
	if blk, err := proposerblock.ParseWithoutVerification(raw); err == nil {
		ethBlock := new(types.Block)
		if err := rlp.DecodeBytes(blk.Block(), ethBlock); err != nil {
			return nil, fmt.Errorf("decode inner eth block: %w", err)
		}
		return ethBlock, nil
	}

	// Fallback: pre-fork block with possible trailing bytes.
	_, _, rest, err := rlp.Split(raw)
	if err != nil {
		return nil, fmt.Errorf("rlp split: %w", err)
	}
	rawBlock := raw[:len(raw)-len(rest)]

	ethBlock := new(types.Block)
	if err := rlp.DecodeBytes(rawBlock, ethBlock); err != nil {
		return nil, fmt.Errorf("decode pre-fork eth block: %w", err)
	}
	return ethBlock, nil
}

// ProcessBlock executes a single block and persists the resulting state changes.
// MDBX requires transactions to stay on the same OS thread, so we lock here.
func (e *Executor) ProcessBlock(blockNum uint64) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	// --- Read phase (RO txn) ---
	roTx, err := e.db.BeginRO()
	if err != nil {
		return fmt.Errorf("begin RO txn: %w", err)
	}

	raw, err := store.GetBlockByNumber(roTx, e.db, blockNum)
	if err != nil {
		roTx.Abort()
		return fmt.Errorf("get block %d: %w", blockNum, err)
	}

	ethBlock, err := parseEthBlock(raw)
	if err != nil {
		roTx.Abort()
		return fmt.Errorf("parse block %d: %w", blockNum, err)
	}

	header := ethBlock.Header()

	statedb := NewStateDB(roTx, e.db)

	// Set Avalanche header extras (TimeMilliseconds, etc.) from the parsed header.
	ccustomtypes.SetHeaderExtra(header, &ccustomtypes.HeaderExtra{})

	// getHashFn — returns zero hash for simplicity; early blocks rarely use BLOCKHASH.
	getHashFn := func(n uint64) common.Hash {
		return common.Hash{}
	}

	blockCtx := BuildBlockContext(header, e.chainCfg, getHashFn)

	gp := new(corethcore.GasPool).AddGas(header.GasLimit)
	signer := types.MakeSigner(e.chainCfg, header.Number, header.Time)
	rules := e.chainCfg.Rules(header.Number, cparams.IsMergeTODO, header.Time)
	baseFee := header.BaseFee
	if baseFee == nil {
		baseFee = new(big.Int)
	}

	for txIndex, tx := range ethBlock.Transactions() {
		msg, err := corethcore.TransactionToMessage(tx, signer, baseFee)
		if err != nil {
			roTx.Abort()
			return fmt.Errorf("block %d tx %d message: %w", blockNum, txIndex, err)
		}

		statedb.SetTxContext(tx.Hash(), txIndex)
		statedb.Prepare(rules, msg.From, header.Coinbase, msg.To,
			vm.ActivePrecompiles(rules), tx.AccessList())

		evm := vm.NewEVM(blockCtx, corethcore.NewEVMTxContext(msg), statedb, e.chainCfg, vm.Config{})
		result, err := corethcore.ApplyMessage(evm, msg, gp)
		if err != nil {
			log.Printf("block %d tx %d apply error: %v", blockNum, txIndex, err)
		} else if result.Failed() {
			log.Printf("block %d tx %d reverted: %v", blockNum, txIndex, result.Err)
		}
	}

	// Apply atomic transactions (cross-chain imports/exports).
	// These modify account balances and must be applied before state root computation.
	extData := ccustomtypes.BlockExtData(ethBlock)
	if len(extData) > 0 {
		// Determine whether we're in ApricotPhase5 (batch mode) or earlier (single tx).
		isAP5 := false
		if rulesExtra := cparams.GetRulesExtra(rules); rulesExtra != nil {
			isAP5 = rulesExtra.AvalancheRules.IsApricotPhase5
		}

		atomicTxs, err := atomic.ExtractAtomicTxs(extData, isAP5, atomic.Codec)
		if err != nil {
			roTx.Abort()
			return fmt.Errorf("block %d extract atomic txs: %w", blockNum, err)
		}

		for i, tx := range atomicTxs {
			if err := tx.UnsignedAtomicTx.EVMStateTransfer(e.snowCtx, statedb); err != nil {
				roTx.Abort()
				return fmt.Errorf("block %d atomic tx %d state transfer: %w", blockNum, i, err)
			}
		}
	}

	// Collect all state mutations relative to MDBX base state.
	changes := statedb.CollectChanges()

	// Done with read phase.
	roTx.Abort()

	// --- Write phase (RW txn) ---
	rwTx, err := e.db.BeginRW()
	if err != nil {
		return fmt.Errorf("begin RW txn: %w", err)
	}

	// Apply state changes.
	for _, sc := range changes {
		var addr20 [20]byte
		copy(addr20[:], sc.Address[:])

		if sc.IsAccount {
			// Account-level change (balance, nonce, or code).
			if err := applyAccountChange(rwTx, e.db, addr20, sc, statedb); err != nil {
				rwTx.Abort()
				return fmt.Errorf("block %d apply account change for %x: %w", blockNum, addr20, err)
			}
		} else {
			// Storage slot change — write new value to flat state.
			var slot32 [32]byte
			copy(slot32[:], sc.Slot[:])
			if err := store.PutStorage(rwTx, e.db, addr20, slot32, sc.NewValue); err != nil {
				rwTx.Abort()
				return fmt.Errorf("block %d put storage: %w", blockNum, err)
			}
		}

		// Record history: get keyID, write changeset entry, update index.
		var slot32 [32]byte
		copy(slot32[:], sc.Slot[:])
		keyID, err := store.GetOrAssignKeyID(rwTx, e.db, addr20, slot32)
		if err != nil {
			rwTx.Abort()
			return fmt.Errorf("block %d get key id: %w", blockNum, err)
		}

		if err := store.UpdateHistoryIndex(rwTx, e.db, keyID, blockNum); err != nil {
			rwTx.Abort()
			return fmt.Errorf("block %d update history index: %w", blockNum, err)
		}
	}

	// Write the full changeset for this block.
	storeChanges, err := buildStoreChanges(rwTx, e.db, changes)
	if err != nil {
		rwTx.Abort()
		return fmt.Errorf("block %d build changeset: %w", blockNum, err)
	}
	if len(storeChanges) > 0 {
		if err := store.WriteChangeset(rwTx, e.db, blockNum, storeChanges); err != nil {
			rwTx.Abort()
			return fmt.Errorf("block %d write changeset: %w", blockNum, err)
		}
	}

	// --- Trie verification ---
	// Build ChangedKeys from state changes for the trie computation.
	changedKeys := buildChangedKeys(changes)

	// Compute state root from the RW txn (which has the new flat state).
	computedRoot, trieUpdates, err := trie.ComputeStateRoot(rwTx, e.db, changedKeys)
	if err != nil {
		rwTx.Abort()
		return fmt.Errorf("block %d compute state root: %w", blockNum, err)
	}

	expectedRoot := header.Root
	if computedRoot != expectedRoot {
		rwTx.Abort()
		return fmt.Errorf("block %d state root mismatch: computed %x, expected %x",
			blockNum, computedRoot, expectedRoot)
	}


	// Write trie node updates.
	if err := writeTrieUpdates(rwTx, e.db, trieUpdates); err != nil {
		rwTx.Abort()
		return fmt.Errorf("block %d write trie updates: %w", blockNum, err)
	}

	// Update head block.
	if err := store.SetHeadBlock(rwTx, e.db, blockNum); err != nil {
		rwTx.Abort()
		return fmt.Errorf("block %d set head: %w", blockNum, err)
	}

	if _, err := rwTx.Commit(); err != nil {
		return fmt.Errorf("block %d commit: %w", blockNum, err)
	}

	return nil
}

// buildChangedKeys extracts the set of changed accounts and storage slots
// from the collected state changes.
func buildChangedKeys(changes []StateChange) *trie.ChangedKeys {
	ck := &trie.ChangedKeys{
		Accounts:  make(map[common.Address]bool),
		Storage:   make(map[common.Address]map[common.Hash]bool),
		Destroyed: make(map[common.Address]bool),
	}
	for _, sc := range changes {
		ck.Accounts[sc.Address] = true
		if !sc.IsAccount {
			if ck.Storage[sc.Address] == nil {
				ck.Storage[sc.Address] = make(map[common.Hash]bool)
			}
			ck.Storage[sc.Address][sc.Slot] = true
		}
	}
	return ck
}

// writeTrieUpdates persists trie node updates to the AccountTrie and StorageTrie tables.
func writeTrieUpdates(tx *mdbx.Txn, db *store.DB, updates *trie.TrieUpdates) error {
	// Write account trie nodes.
	for path, node := range updates.AccountNodes {
		if err := tx.Put(db.AccountTrie, []byte(path), node.Encode(), 0); err != nil {
			return fmt.Errorf("put account trie node: %w", err)
		}
	}
	for path := range updates.AccountRemovals {
		if err := tx.Del(db.AccountTrie, []byte(path), nil); err != nil && !mdbx.IsNotFound(err) {
			return fmt.Errorf("del account trie node: %w", err)
		}
	}

	// Write storage trie nodes.
	for addr, nodes := range updates.StorageNodes {
		for path, node := range nodes {
			key := append([]byte(addr), []byte(path)...)
			if err := tx.Put(db.StorageTrie, key, node.Encode(), 0); err != nil {
				return fmt.Errorf("put storage trie node: %w", err)
			}
		}
	}
	for addr, paths := range updates.StorageRemovals {
		for path := range paths {
			key := append([]byte(addr), []byte(path)...)
			if err := tx.Del(db.StorageTrie, key, nil); err != nil && !mdbx.IsNotFound(err) {
				return fmt.Errorf("del storage trie node: %w", err)
			}
		}
	}

	return nil
}

// applyAccountChange reads the current account from the RW txn, applies the
// mutation described by the StateChange, and writes it back.
func applyAccountChange(rwTx *mdbx.Txn, db *store.DB, addr [20]byte, sc StateChange, sdb *StateDB) error {
	acct, err := store.GetAccount(rwTx, db, addr)
	if err != nil {
		return err
	}
	if acct == nil {
		acct = &store.Account{
			CodeHash: store.EmptyCodeHash,
		}
	}

	// The overlay tracks balance, nonce, and code separately. We apply the
	// latest overlay values rather than decoding from NewValue, since multiple
	// changes to the same account may be collapsed.
	a := sc.Address
	if bal, ok := sdb.balanceOverrides[a]; ok {
		bal.WriteToArray32(&acct.Balance)
	}
	if nonce, ok := sdb.nonceOverrides[a]; ok {
		acct.Nonce = nonce
	}
	if code, ok := sdb.codeOverrides[a]; ok {
		if len(code) > 0 {
			h := crypto.Keccak256Hash(code)
			acct.CodeHash = [32]byte(h)
			if err := store.PutCode(rwTx, db, acct.CodeHash, code); err != nil {
				return err
			}
		} else {
			acct.CodeHash = store.EmptyCodeHash
		}
	}

	// EIP-161: delete empty accounts (balance=0, nonce=0, emptyCodeHash).
	// The EVM "touches" precompile addresses during CALL, creating empty state
	// entries. Geth's Finalise(true) removes these; we must do the same.
	isEmpty := acct.Nonce == 0 && acct.CodeHash == store.EmptyCodeHash
	if isEmpty {
		var zeroBal [32]byte
		isEmpty = acct.Balance == zeroBal
	}
	if isEmpty {
		// Delete the account if it exists (no-op if not found).
		err := rwTx.Del(db.AccountState, addr[:], nil)
		if err != nil && !mdbx.IsNotFound(err) {
			return err
		}
		return nil
	}

	return store.PutAccount(rwTx, db, addr, acct)
}

// buildStoreChanges converts StateChanges into store.Change entries with resolved keyIDs.
func buildStoreChanges(rwTx *mdbx.Txn, db *store.DB, changes []StateChange) ([]store.Change, error) {
	result := make([]store.Change, 0, len(changes))
	for _, sc := range changes {
		var addr20 [20]byte
		copy(addr20[:], sc.Address[:])
		var slot32 [32]byte
		copy(slot32[:], sc.Slot[:])

		keyID, err := store.GetOrAssignKeyID(rwTx, db, addr20, slot32)
		if err != nil {
			return nil, err
		}

		result = append(result, store.Change{
			KeyID:    keyID,
			OldValue: sc.OldValue[:],
		})
	}
	return result, nil
}

// dumpState prints all accounts and storage for debugging state root mismatches.
func dumpState(tx *mdbx.Txn, db *store.DB, blockNum uint64) {
	log.Printf("=== STATE DUMP at block %d ===", blockNum)

	// Dump accounts
	acctCursor, err := tx.OpenCursor(db.AccountState)
	if err != nil {
		log.Printf("  failed to open AccountState cursor: %v", err)
		return
	}
	defer acctCursor.Close()

	k, v, err := acctCursor.Get(nil, nil, mdbx.First)
	for err == nil {
		if len(k) >= 20 {
			nonce := uint64(0)
			if len(v) >= 8 {
				for i := 0; i < 8; i++ {
					nonce = nonce<<8 | uint64(v[i])
				}
			}
			var balance [32]byte
			if len(v) >= 40 {
				copy(balance[:], v[8:40])
			}
			var codeHash [32]byte
			if len(v) >= 72 {
				copy(codeHash[:], v[40:72])
			}
			hasCode := codeHash != store.EmptyCodeHash && codeHash != [32]byte{}
			log.Printf("  ACCT %x nonce=%d balance=%x hasCode=%v codeHash=%x",
				k[:20], nonce, balance, hasCode, codeHash)
		}
		k, v, err = acctCursor.Get(nil, nil, mdbx.Next)
	}

	// Dump storage
	storCursor, err := tx.OpenCursor(db.StorageState)
	if err != nil {
		log.Printf("  failed to open StorageState cursor: %v", err)
		return
	}
	defer storCursor.Close()

	k, v, err = storCursor.Get(nil, nil, mdbx.First)
	for err == nil {
		if len(k) >= 52 {
			log.Printf("  STOR %x slot=%x val=%x", k[:20], k[20:52], v)
		}
		k, v, err = storCursor.Get(nil, nil, mdbx.Next)
	}
	log.Printf("=== END STATE DUMP ===")
}

// Run executes blocks sequentially from fromBlock to toBlock (inclusive).
func (e *Executor) Run(fromBlock, toBlock uint64) error {
	for blockNum := fromBlock; blockNum <= toBlock; blockNum++ {
		if err := e.ProcessBlock(blockNum); err != nil {
			return fmt.Errorf("block %d: %w", blockNum, err)
		}
		if blockNum%100 == 0 {
			log.Printf("processed block %d / %d", blockNum, toBlock)
		}
	}
	return nil
}
