// statetrie_verify uses our custom state.Trie (flat MDBX + StackTrie hashing)
// to process C-Chain blocks and verify state roots.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math/big"
	"runtime"
	"time"

	"github.com/ava-labs/avalanchego/genesis"
	corethcore "github.com/ava-labs/avalanchego/graft/coreth/core"
	"github.com/ava-labs/avalanchego/graft/coreth/core/extstate"
	cparams "github.com/ava-labs/avalanchego/graft/coreth/params"
	"github.com/ava-labs/avalanchego/graft/coreth/plugin/evm/atomic"
	ccustomtypes "github.com/ava-labs/avalanchego/graft/coreth/plugin/evm/customtypes"
	"github.com/ava-labs/avalanchego/ids"
	"github.com/ava-labs/avalanchego/snow"
	"github.com/ava-labs/avalanchego/utils/constants"
	proposerblock "github.com/ava-labs/avalanchego/vms/proposervm/block"
	"github.com/ava-labs/libevm/common"
	"github.com/ava-labs/libevm/core/state"
	"github.com/ava-labs/libevm/core/types"
	"github.com/ava-labs/libevm/core/vm"
	"github.com/ava-labs/libevm/crypto"
	"github.com/ava-labs/libevm/params"
	"github.com/ava-labs/libevm/rlp"
	"github.com/holiman/uint256"

	"block_fetcher/executor"
	"block_fetcher/statetrie"
	"block_fetcher/store"
)

const MainnetAVAXAssetID = "FvwEAhmxKfeiG8SnEvq42hc6whRyY3EFYAvebMqDNDGCgxN5Z"

func main() {
	corethcore.RegisterExtras()
	ccustomtypes.Register()
	extstate.RegisterExtras()
	cparams.RegisterExtras()

	dbDir := flag.String("db-dir", "data/mainnet-mdbx", "MDBX database directory")
	fromBlock := flag.Uint64("from", 1, "first block to process")
	toBlock := flag.Uint64("to", 19, "last block to process")
	cleanState := flag.Bool("clean-state", false, "Clear flat state tables before running")
	flag.Parse()

	// Parse genesis.
	config := genesis.GetConfig(constants.MainnetID)
	var cChainGenesis corethcore.Genesis
	if err := json.Unmarshal([]byte(config.CChainGenesis), &cChainGenesis); err != nil {
		log.Fatalf("parse C-Chain genesis: %v", err)
	}
	if err := cparams.SetEthUpgrades(cChainGenesis.Config); err != nil {
		log.Fatalf("set eth upgrades: %v", err)
	}
	chainCfg := cChainGenesis.Config

	// Open MDBX.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	mdbxDB, err := store.Open(*dbDir)
	if err != nil {
		log.Fatalf("open MDBX: %v", err)
	}
	defer mdbxDB.Close()

	// Clear flat state if requested.
	if *cleanState {
		log.Println("Clearing flat state tables...")
		if err := mdbxDB.ClearState(); err != nil {
			log.Fatalf("clear state: %v", err)
		}
	}

	// Load genesis into flat MDBX tables.
	if err := loadGenesisFlat(mdbxDB, &cChainGenesis); err != nil {
		log.Fatalf("load genesis: %v", err)
	}

	// Verify genesis root with our trie.
	stateDB := statetrie.NewDatabase(mdbxDB)
	genesisRoot := computeGenesisRoot(stateDB)
	expectedGenesisRoot := cChainGenesis.ToBlock().Root()
	log.Printf("Genesis root: computed=%x expected=%x match=%v", genesisRoot, expectedGenesisRoot, genesisRoot == expectedGenesisRoot)
	if genesisRoot != expectedGenesisRoot {
		log.Fatalf("Genesis root mismatch!")
	}

	// Set up snow.Context for atomic transactions.
	avaxAssetID, err := ids.FromString(MainnetAVAXAssetID)
	if err != nil {
		log.Fatalf("invalid AVAX asset ID: %v", err)
	}
	snowCtx := &snow.Context{AVAXAssetID: avaxAssetID}

	parentRoot := genesisRoot
	startTime := time.Now()

	for blockNum := *fromBlock; blockNum <= *toBlock; blockNum++ {
		if err := processBlock(mdbxDB, stateDB, chainCfg, snowCtx, blockNum, &parentRoot); err != nil {
			log.Fatalf("block %d: %v", blockNum, err)
		}
	}

	elapsed := time.Since(startTime)
	blocks := *toBlock - *fromBlock + 1
	log.Printf("All blocks %d-%d verified successfully! elapsed=%v blocks/sec=%.1f",
		*fromBlock, *toBlock, elapsed.Round(time.Millisecond), float64(blocks)/elapsed.Seconds())
}

func loadGenesisFlat(db *store.DB, gen *corethcore.Genesis) error {
	// Check if already loaded.
	tx, err := db.BeginRO()
	if err != nil {
		return err
	}
	_, loadErr := tx.Get(db.Metadata, []byte("genesis_loaded"))
	tx.Abort()
	if loadErr == nil {
		return nil // already loaded
	}

	// Write genesis alloc to flat state.
	rwTx, err := db.BeginRW()
	if err != nil {
		return err
	}

	for addr, account := range gen.Alloc {
		var addr20 [20]byte
		copy(addr20[:], addr[:])

		codeHash := store.EmptyCodeHash
		if len(account.Code) > 0 {
			codeHash = [32]byte(crypto.Keccak256Hash(account.Code))
			if err := store.PutCode(rwTx, db, codeHash, account.Code); err != nil {
				rwTx.Abort()
				return err
			}
		}

		var balance [32]byte
		if account.Balance != nil {
			bal, _ := uint256.FromBig(account.Balance)
			bal.WriteToArray32(&balance)
		}

		acct := &store.Account{
			Nonce:       account.Nonce,
			Balance:     balance,
			CodeHash:    codeHash,
			StorageRoot: store.EmptyRootHash,
		}
		if err := store.PutAccount(rwTx, db, addr20, acct); err != nil {
			rwTx.Abort()
			return err
		}

		for slot, value := range account.Storage {
			if err := store.PutStorage(rwTx, db, addr20, [32]byte(slot), [32]byte(value)); err != nil {
				rwTx.Abort()
				return err
			}
		}
	}

	if err := rwTx.Put(db.Metadata, []byte("genesis_loaded"), []byte{1}, 0); err != nil {
		rwTx.Abort()
		return err
	}

	_, err = rwTx.Commit()
	return err
}

func computeGenesisRoot(stateDB state.Database) common.Hash {
	t, err := stateDB.OpenTrie(common.Hash{})
	if err != nil {
		log.Fatalf("open trie: %v", err)
	}
	return t.Hash()
}

func processBlock(
	mdbxDB *store.DB,
	stateDB state.Database,
	chainCfg *params.ChainConfig,
	snowCtx *snow.Context,
	blockNum uint64,
	parentRoot *common.Hash,
) error {
	// Read raw block.
	roTx, err := mdbxDB.BeginRO()
	if err != nil {
		return fmt.Errorf("begin RO: %w", err)
	}
	raw, err := store.GetBlockByNumber(roTx, mdbxDB, blockNum)
	if err != nil {
		roTx.Abort()
		return fmt.Errorf("get block: %w", err)
	}
	raw = append([]byte(nil), raw...)
	roTx.Abort()

	ethBlock, err := parseEthBlock(raw)
	if err != nil {
		return fmt.Errorf("parse block: %w", err)
	}

	header := ethBlock.Header()
	expectedRoot := header.Root

	// Create StateDB using our custom trie.
	sdb, err := state.New(*parentRoot, stateDB, nil)
	if err != nil {
		return fmt.Errorf("open state at root %x: %w", *parentRoot, err)
	}

	// Set Avalanche header extras.
	ccustomtypes.SetHeaderExtra(header, &ccustomtypes.HeaderExtra{})

	// Build block context.
	blockCtx := executor.BuildBlockContext(header, chainCfg, func(n uint64) common.Hash { return common.Hash{} })

	gp := new(corethcore.GasPool).AddGas(header.GasLimit)
	signer := types.MakeSigner(chainCfg, header.Number, header.Time)
	baseFee := header.BaseFee
	if baseFee == nil {
		baseFee = new(big.Int)
	}

	// Process transactions.
	for txIndex, tx := range ethBlock.Transactions() {
		msg, err := corethcore.TransactionToMessage(tx, signer, baseFee)
		if err != nil {
			return fmt.Errorf("tx %d message: %w", txIndex, err)
		}

		sdb.SetTxContext(tx.Hash(), txIndex)
		rules := chainCfg.Rules(header.Number, cparams.IsMergeTODO, header.Time)
		sdb.Prepare(rules, msg.From, header.Coinbase, msg.To,
			vm.ActivePrecompiles(rules), tx.AccessList())

		evm := vm.NewEVM(blockCtx, corethcore.NewEVMTxContext(msg), sdb, chainCfg, vm.Config{})
		result, err := corethcore.ApplyMessage(evm, msg, gp)
		if err != nil {
			return fmt.Errorf("tx %d apply: %w", txIndex, err)
		}
		sdb.Finalise(true)

		if result.Failed() {
			log.Printf("  block %d tx %d reverted: %v", blockNum, txIndex, result.Err)
		}
	}

	// Process atomic transactions.
	extData := ccustomtypes.BlockExtData(ethBlock)
	if len(extData) > 0 {
		rules := chainCfg.Rules(header.Number, cparams.IsMergeTODO, header.Time)
		isAP5 := false
		if rulesExtra := cparams.GetRulesExtra(rules); rulesExtra != nil {
			isAP5 = rulesExtra.AvalancheRules.IsApricotPhase5
		}
		atomicTxs, err := atomic.ExtractAtomicTxs(extData, isAP5, atomic.Codec)
		if err != nil {
			return fmt.Errorf("extract atomic txs: %w", err)
		}
		wrappedStateDB := extstate.New(sdb)
		for i, tx := range atomicTxs {
			if err := tx.UnsignedAtomicTx.EVMStateTransfer(snowCtx, wrappedStateDB); err != nil {
				return fmt.Errorf("atomic tx %d: %w", i, err)
			}
		}
	}

	// Compute and verify state root.
	computedRoot := sdb.IntermediateRoot(true)
	if computedRoot != expectedRoot {
		return fmt.Errorf("state root mismatch: computed %x, expected %x", computedRoot, expectedRoot)
	}

	// Commit state — this flushes dirty state to our flat MDBX tables.
	root, err := sdb.Commit(blockNum, true)
	if err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	_ = root

	// Update head block in metadata.
	rwTx, err := mdbxDB.BeginRW()
	if err != nil {
		return fmt.Errorf("begin RW for head: %w", err)
	}
	if err := store.SetHeadBlock(rwTx, mdbxDB, blockNum); err != nil {
		rwTx.Abort()
		return fmt.Errorf("set head: %w", err)
	}
	if _, err := rwTx.Commit(); err != nil {
		return fmt.Errorf("commit head: %w", err)
	}

	*parentRoot = computedRoot
	if blockNum%100 == 0 || blockNum <= 20 {
		log.Printf("Block %d OK  root=%x  txs=%d", blockNum, computedRoot, len(ethBlock.Transactions()))
	}
	return nil
}

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
