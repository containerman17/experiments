// coreth_verify uses the REAL coreth/libevm code to process C-Chain blocks
// and verify state roots. It reads raw blocks from MDBX, sets up an in-memory
// trie database seeded with genesis, then processes blocks 0-19 using coreth's
// actual state processing (ApplyMessage, Finalise, IntermediateRoot).
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math/big"
	"runtime"

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
	"github.com/ava-labs/libevm/core/rawdb"
	"github.com/ava-labs/libevm/core/state"
	"github.com/ava-labs/libevm/core/types"
	"github.com/ava-labs/libevm/core/vm"
	"github.com/ava-labs/libevm/ethdb"
	"github.com/ava-labs/libevm/params"
	"github.com/ava-labs/libevm/rlp"
	"github.com/ava-labs/libevm/triedb"
	"github.com/holiman/uint256"

	"block_fetcher/store"
)

const MainnetAVAXAssetID = "FvwEAhmxKfeiG8SnEvq42hc6whRyY3EFYAvebMqDNDGCgxN5Z"

func init() {
	// Register all libevm extras needed for coreth behaviour.
	// Order matters: core hooks, then custom types, then extstate, then params.
	corethcore.RegisterExtras()
	ccustomtypes.Register()
	extstate.RegisterExtras()
	cparams.RegisterExtras()
}

func main() {
	dbDir := flag.String("db", "data/mainnet-mdbx", "MDBX directory with raw blocks")
	fromBlock := flag.Uint64("from", 1, "first block to process")
	toBlock := flag.Uint64("to", 19, "last block to process")
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

	// Set up in-memory database with genesis state.
	memdb := rawdb.NewMemoryDatabase()
	trieDB := triedb.NewDatabase(memdb, nil)
	genesisBlock := cChainGenesis.MustCommit(memdb, trieDB)

	genesisRoot := genesisBlock.Root()
	log.Printf("Genesis block root: %x", genesisRoot)
	log.Printf("Genesis block hash: %x", genesisBlock.Hash())

	// Create state database backed by the trie.
	stateDB := state.NewDatabaseWithNodeDB(memdb, trieDB)

	// Verify we can open genesis state.
	sdb, err := state.New(genesisRoot, stateDB, nil)
	if err != nil {
		log.Fatalf("open genesis state: %v", err)
	}
	_ = sdb

	// Set up snow.Context for atomic transactions.
	avaxAssetID, err := ids.FromString(MainnetAVAXAssetID)
	if err != nil {
		log.Fatalf("invalid AVAX asset ID: %v", err)
	}
	snowCtx := &snow.Context{
		AVAXAssetID: avaxAssetID,
	}

	// Open MDBX for reading raw blocks.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	mdbxDB, err := store.Open(*dbDir)
	if err != nil {
		log.Fatalf("open MDBX: %v", err)
	}
	defer mdbxDB.Close()

	parentRoot := genesisRoot

	for blockNum := *fromBlock; blockNum <= *toBlock; blockNum++ {
		if err := processBlock(mdbxDB, memdb, stateDB, trieDB, chainCfg, snowCtx, blockNum, &parentRoot); err != nil {
			log.Fatalf("block %d: %v", blockNum, err)
		}
	}

	log.Printf("All blocks %d-%d verified successfully!", *fromBlock, *toBlock)
}

func processBlock(
	mdbxDB *store.DB,
	memdb ethdb.Database,
	stateDB state.Database,
	trieDB *triedb.Database,
	chainCfg *params.ChainConfig,
	snowCtx *snow.Context,
	blockNum uint64,
	parentRoot *common.Hash,
) error {
	// Read raw block from MDBX.
	roTx, err := mdbxDB.BeginRO()
	if err != nil {
		return fmt.Errorf("begin RO: %w", err)
	}

	raw, err := store.GetBlockByNumber(roTx, mdbxDB, blockNum)
	if err != nil {
		roTx.Abort()
		return fmt.Errorf("get block: %w", err)
	}
	roTx.Abort()

	ethBlock, err := parseEthBlock(raw)
	if err != nil {
		return fmt.Errorf("parse block: %w", err)
	}

	header := ethBlock.Header()
	expectedRoot := header.Root

	// Create a fresh StateDB from the parent root.
	sdb, err := state.New(*parentRoot, stateDB, nil)
	if err != nil {
		return fmt.Errorf("open state at parent root %x: %w", *parentRoot, err)
	}

	// Set Avalanche header extras.
	ccustomtypes.SetHeaderExtra(header, &ccustomtypes.HeaderExtra{})

	// Build block context using the same logic as our executor.
	getHashFn := func(n uint64) common.Hash {
		return common.Hash{}
	}
	blockCtx := buildBlockContext(header, chainCfg, getHashFn)

	gp := new(corethcore.GasPool).AddGas(header.GasLimit)
	signer := types.MakeSigner(chainCfg, header.Number, header.Time)
	baseFee := header.BaseFee
	if baseFee == nil {
		baseFee = new(big.Int)
	}

	// Process each transaction (same as state_processor.go).
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

		// After each tx: Finalise (same as state_processor.go line 135).
		// Byzantium is active from genesis on C-Chain.
		sdb.Finalise(true)

		if result.Failed() {
			log.Printf("  block %d tx %d reverted: %v", blockNum, txIndex, result.Err)
		}
	}

	// Apply atomic transactions (cross-chain imports/exports).
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

		// Wrap StateDB with extstate for multicoin support.
		wrappedStateDB := extstate.New(sdb)
		for i, tx := range atomicTxs {
			if err := tx.UnsignedAtomicTx.EVMStateTransfer(snowCtx, wrappedStateDB); err != nil {
				return fmt.Errorf("atomic tx %d state transfer: %w", i, err)
			}
		}
	}

	// Compute state root.
	computedRoot := sdb.IntermediateRoot(true)

	if computedRoot != expectedRoot {
		return fmt.Errorf("state root mismatch: computed %x, expected %x", computedRoot, expectedRoot)
	}

	// Commit state so it's available for the next block.
	root, err := sdb.Commit(blockNum, true)
	if err != nil {
		return fmt.Errorf("commit state: %w", err)
	}
	if err := trieDB.Commit(root, false); err != nil {
		return fmt.Errorf("commit trie: %w", err)
	}

	*parentRoot = computedRoot
	log.Printf("Block %d OK  root=%x  txs=%d", blockNum, computedRoot, len(ethBlock.Transactions()))
	return nil
}

// parseEthBlock decodes a raw block from MDBX. It first tries to unwrap a
// ProposerVM envelope; if that fails it falls back to a pre-fork RLP decode.
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

// buildBlockContext constructs the vm.BlockContext needed for EVM execution.
// Matches the logic in executor/blockctx.go.
func buildBlockContext(header *types.Header, chainCfg *params.ChainConfig, getHash func(uint64) common.Hash) vm.BlockContext {
	rules := chainCfg.Rules(header.Number, cparams.IsMergeTODO, header.Time)

	blockDifficulty := new(big.Int)
	if header.Difficulty != nil {
		blockDifficulty.Set(header.Difficulty)
	}
	blockRandom := header.MixDigest
	if rules.IsShanghai {
		blockRandom.SetBytes(blockDifficulty.Bytes())
		blockDifficulty = new(big.Int)
	}

	return vm.BlockContext{
		CanTransfer: func(db vm.StateDB, addr common.Address, amount *uint256.Int) bool {
			return db.GetBalance(addr).Cmp(amount) >= 0
		},
		Transfer: func(db vm.StateDB, sender, recipient common.Address, amount *uint256.Int) {
			db.SubBalance(sender, amount)
			db.AddBalance(recipient, amount)
		},
		GetHash:     getHash,
		Coinbase:    header.Coinbase,
		BlockNumber: new(big.Int).Set(header.Number),
		Time:        header.Time,
		Difficulty:  blockDifficulty,
		Random:      &blockRandom,
		GasLimit:    header.GasLimit,
		BaseFee:     baseFeeOrZero(header.BaseFee),
		Header:      header,
	}
}

func baseFeeOrZero(b *big.Int) *big.Int {
	if b != nil {
		return new(big.Int).Set(b)
	}
	return new(big.Int)
}
