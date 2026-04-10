package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"runtime"
	"sort"

	"github.com/ava-labs/avalanchego/genesis"
	corethcore "github.com/ava-labs/avalanchego/graft/coreth/core"
	cparams "github.com/ava-labs/avalanchego/graft/coreth/params"
	"github.com/ava-labs/avalanchego/graft/coreth/plugin/evm/atomic"
	ccustomtypes "github.com/ava-labs/avalanchego/graft/coreth/plugin/evm/customtypes"
	"github.com/ava-labs/avalanchego/ids"
	"github.com/ava-labs/avalanchego/snow"
	avaconstants "github.com/ava-labs/avalanchego/utils/constants"
	proposerblock "github.com/ava-labs/avalanchego/vms/proposervm/block"
	"github.com/ava-labs/libevm/common"
	"github.com/ava-labs/libevm/core/rawdb"
	"github.com/ava-labs/libevm/core/types"
	"github.com/ava-labs/libevm/core/vm"
	"github.com/ava-labs/libevm/crypto"
	"github.com/ava-labs/libevm/params"
	"github.com/ava-labs/libevm/rlp"
	gethtrie "github.com/ava-labs/libevm/trie"
	"github.com/ava-labs/libevm/triedb"
	"github.com/erigontech/mdbx-go/mdbx"
	"github.com/holiman/uint256"

	"block_fetcher/executor"
	"block_fetcher/store"
	ourtrie "block_fetcher/trie"
)

const targetBlock = 19

func main() {
	cparams.RegisterExtras()
	ccustomtypes.Register()

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	db, err := store.Open("data/mainnet-mdbx")
	if err != nil {
		log.Fatalf("open MDBX: %v", err)
	}
	defer db.Close()

	// Clear state and reload genesis for a clean run.
	log.Println("clearing state tables...")
	if err := db.ClearState(); err != nil {
		log.Fatalf("clear state: %v", err)
	}

	log.Println("loading genesis...")
	rwTx, err := db.BeginRW()
	if err != nil {
		log.Fatalf("begin RW: %v", err)
	}
	if err := executor.LoadGenesis(rwTx, db); err != nil {
		rwTx.Abort()
		log.Fatalf("load genesis: %v", err)
	}
	if _, err := rwTx.Commit(); err != nil {
		log.Fatalf("commit genesis: %v", err)
	}

	// Get chain config.
	config := genesis.GetConfig(avaconstants.MainnetID)
	var cChainGenesis corethcore.Genesis
	if err := json.Unmarshal([]byte(config.CChainGenesis), &cChainGenesis); err != nil {
		log.Fatalf("parse genesis: %v", err)
	}
	chainCfg := cChainGenesis.Config

	// Process blocks 1-18 using the normal executor (which validates roots).
	log.Println("processing blocks 1-18 with normal executor...")
	exec := executor.NewExecutor(db, chainCfg)
	for blockNum := uint64(1); blockNum <= 18; blockNum++ {
		if err := exec.ProcessBlock(blockNum); err != nil {
			log.Fatalf("block %d: %v", blockNum, err)
		}
		log.Printf("block %d OK", blockNum)
	}

	// For block 19: execute manually, skip trie check, write state, then compare tries.
	log.Println("processing block 19 manually (skip trie check)...")
	expectedRoot, err := processBlock19NoTrieCheck(db, chainCfg)
	if err != nil {
		log.Fatalf("process block 19: %v", err)
	}

	// Now state is written. Compare our trie vs geth trie.
	log.Println("computing roots...")
	compareRoots(db, expectedRoot)
}

// processBlock19NoTrieCheck executes block 19, writes state changes, but skips
// trie verification. Returns the expected root from the block header.
func processBlock19NoTrieCheck(db *store.DB, chainCfg *params.ChainConfig) (common.Hash, error) {
	avaxAssetID, _ := ids.FromString(executor.MainnetAVAXAssetID)
	snowCtx := &snow.Context{AVAXAssetID: avaxAssetID}

	roTx, err := db.BeginRO()
	if err != nil {
		return common.Hash{}, err
	}

	raw, err := store.GetBlockByNumber(roTx, db, targetBlock)
	if err != nil {
		roTx.Abort()
		return common.Hash{}, fmt.Errorf("get block: %w", err)
	}

	ethBlock, err := parseEthBlock(raw)
	if err != nil {
		roTx.Abort()
		return common.Hash{}, fmt.Errorf("parse block: %w", err)
	}

	header := ethBlock.Header()
	statedb := executor.NewStateDB(roTx, db)
	ccustomtypes.SetHeaderExtra(header, &ccustomtypes.HeaderExtra{})

	getHashFn := func(n uint64) common.Hash { return common.Hash{} }
	blockCtx := executor.BuildBlockContext(header, chainCfg, getHashFn)

	gp := new(corethcore.GasPool).AddGas(header.GasLimit)
	signer := types.MakeSigner(chainCfg, header.Number, header.Time)
	rules := chainCfg.Rules(header.Number, cparams.IsMergeTODO, header.Time)
	baseFee := header.BaseFee
	if baseFee == nil {
		baseFee = new(big.Int)
	}

	for txIndex, tx := range ethBlock.Transactions() {
		msg, err := corethcore.TransactionToMessage(tx, signer, baseFee)
		if err != nil {
			roTx.Abort()
			return common.Hash{}, fmt.Errorf("tx %d message: %w", txIndex, err)
		}
		statedb.SetTxContext(tx.Hash(), txIndex)
		statedb.Prepare(rules, msg.From, header.Coinbase, msg.To,
			vm.ActivePrecompiles(rules), tx.AccessList())
		evm := vm.NewEVM(blockCtx, corethcore.NewEVMTxContext(msg), statedb, chainCfg, vm.Config{})
		result, err := corethcore.ApplyMessage(evm, msg, gp)
		if err != nil {
			log.Printf("block %d tx %d apply error: %v", targetBlock, txIndex, err)
		} else if result.Failed() {
			log.Printf("block %d tx %d reverted: %v", targetBlock, txIndex, result.Err)
		}
	}

	// Apply atomic transactions.
	extData := ccustomtypes.BlockExtData(ethBlock)
	if len(extData) > 0 {
		isAP5 := false
		if rulesExtra := cparams.GetRulesExtra(rules); rulesExtra != nil {
			isAP5 = rulesExtra.AvalancheRules.IsApricotPhase5
		}
		atomicTxs, err := atomic.ExtractAtomicTxs(extData, isAP5, atomic.Codec)
		if err != nil {
			roTx.Abort()
			return common.Hash{}, fmt.Errorf("extract atomic txs: %w", err)
		}
		for i, tx := range atomicTxs {
			if err := tx.UnsignedAtomicTx.EVMStateTransfer(snowCtx, statedb); err != nil {
				roTx.Abort()
				return common.Hash{}, fmt.Errorf("atomic tx %d: %w", i, err)
			}
		}
	}

	changes := statedb.CollectChanges()
	roTx.Abort()

	// Write state changes (without trie verification).
	rwTx, err := db.BeginRW()
	if err != nil {
		return common.Hash{}, err
	}

	for _, sc := range changes {
		var addr20 [20]byte
		copy(addr20[:], sc.Address[:])
		if sc.IsAccount {
			if err := applyAccountChange(rwTx, db, addr20, sc, statedb); err != nil {
				rwTx.Abort()
				return common.Hash{}, fmt.Errorf("apply account change %x: %w", addr20, err)
			}
		} else {
			var slot32 [32]byte
			copy(slot32[:], sc.Slot[:])
			if err := store.PutStorage(rwTx, db, addr20, slot32, sc.NewValue); err != nil {
				rwTx.Abort()
				return common.Hash{}, fmt.Errorf("put storage: %w", err)
			}
		}
	}

	if _, err := rwTx.Commit(); err != nil {
		return common.Hash{}, fmt.Errorf("commit: %w", err)
	}

	return header.Root, nil
}

// applyAccountChange mirrors executor.applyAccountChange.
func applyAccountChange(rwTx *mdbx.Txn, db *store.DB, addr [20]byte, sc executor.StateChange, sdb *executor.StateDB) error {
	acct, err := store.GetAccount(rwTx, db, addr)
	if err != nil {
		return err
	}
	if acct == nil {
		acct = &store.Account{CodeHash: store.EmptyCodeHash}
	}

	a := sc.Address
	if bal := sdb.GetBalanceOverride(a); bal != nil {
		bal.WriteToArray32(&acct.Balance)
	}
	if nonce, ok := sdb.GetNonceOverride(a); ok {
		acct.Nonce = nonce
	}
	if code, ok := sdb.GetCodeOverride(a); ok {
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

	return store.PutAccount(rwTx, db, addr, acct)
}

// compareRoots computes state root using both our HashBuilder and geth's trie,
// then compares with the expected root.
func compareRoots(db *store.DB, expectedRoot common.Hash) {
	roTx, err := db.BeginRO()
	if err != nil {
		log.Fatalf("begin RO: %v", err)
	}
	defer roTx.Abort()

	// --- Collect all accounts and storage from MDBX ---
	type accountData struct {
		addr     [20]byte
		nonce    uint64
		balance  [32]byte
		codeHash [32]byte
	}
	type storageEntry struct {
		slot  [32]byte
		value []byte // leading zeros stripped
	}

	accounts := make(map[[20]byte]*accountData)
	storageByAddr := make(map[[20]byte][]storageEntry)

	// Scan AccountState.
	acctCursor, err := roTx.OpenCursor(db.AccountState)
	if err != nil {
		log.Fatalf("open AccountState cursor: %v", err)
	}
	defer acctCursor.Close()

	k, v, err := acctCursor.Get(nil, nil, mdbx.First)
	for err == nil {
		if len(k) >= 20 {
			var addr [20]byte
			copy(addr[:], k[:20])
			acct := store.DecodeAccount(v)
			accounts[addr] = &accountData{
				addr:     addr,
				nonce:    acct.Nonce,
				balance:  acct.Balance,
				codeHash: acct.CodeHash,
			}
		}
		k, v, err = acctCursor.Get(nil, nil, mdbx.Next)
	}

	// Scan StorageState.
	storCursor, err := roTx.OpenCursor(db.StorageState)
	if err != nil {
		log.Fatalf("open StorageState cursor: %v", err)
	}
	defer storCursor.Close()

	k, v, err = storCursor.Get(nil, nil, mdbx.First)
	for err == nil {
		if len(k) >= 52 {
			var addr [20]byte
			var slot [32]byte
			copy(addr[:], k[:20])
			copy(slot[:], k[20:52])
			valCopy := make([]byte, len(v))
			copy(valCopy, v)
			storageByAddr[addr] = append(storageByAddr[addr], storageEntry{slot: slot, value: valCopy})
		}
		k, v, err = storCursor.Get(nil, nil, mdbx.Next)
	}

	log.Printf("total accounts: %d", len(accounts))
	log.Printf("accounts with storage: %d", len(storageByAddr))

	// Dump accounts and storage for block 19 inspection.
	log.Println("--- Account dump ---")
	sortedAddrs := make([][20]byte, 0, len(accounts))
	for addr := range accounts {
		sortedAddrs = append(sortedAddrs, addr)
	}
	sort.Slice(sortedAddrs, func(i, j int) bool {
		for x := 0; x < 20; x++ {
			if sortedAddrs[i][x] != sortedAddrs[j][x] {
				return sortedAddrs[i][x] < sortedAddrs[j][x]
			}
		}
		return false
	})
	for _, addr := range sortedAddrs {
		acct := accounts[addr]
		bal := new(uint256.Int).SetBytes32(acct.balance[:])
		log.Printf("  %x nonce=%d balance=%s codeHash=%x",
			addr, acct.nonce, bal.ToBig().String(), acct.codeHash)
		if slots, ok := storageByAddr[addr]; ok {
			for _, s := range slots {
				log.Printf("    slot=%x value=%x", s.slot, s.value)
			}
		}
	}

	// --- Compute root with geth's trie ---
	gethTrieDB := triedb.NewDatabase(rawdb.NewMemoryDatabase(), nil)
	gethAccountTrie := gethtrie.NewEmpty(gethTrieDB)

	for addr, slots := range storageByAddr {
		storageTrie := gethtrie.NewEmpty(gethTrieDB)
		for _, s := range slots {
			hashedSlot := crypto.Keccak256(s.slot[:])
			// Storage values: geth's StateTrie.UpdateStorage RLP-encodes the
			// value before calling trie.Update (see secure_trie.go:157).
			trimmed := common.TrimLeftZeroes(s.value)
			if len(trimmed) == 0 {
				continue
			}
			rlpVal, _ := rlp.EncodeToBytes(trimmed)
			if err := storageTrie.Update(hashedSlot, rlpVal); err != nil {
				log.Fatalf("geth storage trie update: %v", err)
			}
		}
		storageRoot := storageTrie.Hash()

		acct := accounts[addr]
		sa := types.StateAccount{
			Nonce:    acct.nonce,
			Balance:  new(uint256.Int).SetBytes32(acct.balance[:]),
			Root:     storageRoot,
			CodeHash: acct.codeHash[:],
		}
		rlpVal, err := rlp.EncodeToBytes(&sa)
		if err != nil {
			log.Fatalf("rlp encode account: %v", err)
		}
		hashedAddr := crypto.Keccak256(addr[:])
		if err := gethAccountTrie.Update(hashedAddr, rlpVal); err != nil {
			log.Fatalf("geth account trie update: %v", err)
		}
	}

	// Also add accounts without storage.
	emptyRoot := types.EmptyRootHash
	for addr, acct := range accounts {
		if _, hasStorage := storageByAddr[addr]; hasStorage {
			continue // already handled above
		}
		sa := types.StateAccount{
			Nonce:    acct.nonce,
			Balance:  new(uint256.Int).SetBytes32(acct.balance[:]),
			Root:     emptyRoot,
			CodeHash: acct.codeHash[:],
		}
		rlpVal, err := rlp.EncodeToBytes(&sa)
		if err != nil {
			log.Fatalf("rlp encode account: %v", err)
		}
		hashedAddr := crypto.Keccak256(addr[:])
		if err := gethAccountTrie.Update(hashedAddr, rlpVal); err != nil {
			log.Fatalf("geth account trie update: %v", err)
		}
	}

	gethRoot := gethAccountTrie.Hash()

	// --- Compute root with our HashBuilder ---
	changedKeys := &ourtrie.ChangedKeys{
		Accounts:  make(map[common.Address]bool),
		Storage:   make(map[common.Address]map[common.Hash]bool),
		Destroyed: make(map[common.Address]bool),
	}
	ourRoot, _, err := ourtrie.ComputeStateRoot(roTx, db, changedKeys)
	if err != nil {
		log.Fatalf("our ComputeStateRoot: %v", err)
	}

	log.Println("=== ROOT COMPARISON ===")
	log.Printf("expected root (block header): %x", expectedRoot)
	log.Printf("geth trie root:               %x", gethRoot)
	log.Printf("our HashBuilder root:         %x", ourRoot)
	log.Printf("geth matches expected:        %v", gethRoot == expectedRoot)
	log.Printf("ours matches expected:        %v", ourRoot == expectedRoot)
	log.Printf("geth matches ours:            %v", gethRoot == ourRoot)

	if gethRoot == expectedRoot && ourRoot != expectedRoot {
		log.Println("CONCLUSION: Bug is in our trie implementation (HashBuilder)")
	} else if gethRoot != expectedRoot && ourRoot != expectedRoot {
		log.Println("CONCLUSION: Bug is in state changes (both tries disagree with expected)")
	} else if gethRoot != expectedRoot && ourRoot == expectedRoot {
		log.Println("CONCLUSION: Unexpected - our trie matches but geth doesn't (check geth trie usage)")
	} else {
		log.Println("CONCLUSION: Both match! No bug at block 19.")
	}
}

// parseEthBlock is copied from executor to avoid circular imports.
func parseEthBlock(raw []byte) (*types.Block, error) {
	if blk, err := proposerblock.ParseWithoutVerification(raw); err == nil {
		ethBlock := new(types.Block)
		if err := rlp.DecodeBytes(blk.Block(), ethBlock); err != nil {
			return nil, fmt.Errorf("decode inner eth block: %w", err)
		}
		return ethBlock, nil
	}
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
