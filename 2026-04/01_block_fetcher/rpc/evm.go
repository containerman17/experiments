package rpc

import (
	"encoding/json"
	"fmt"
	"math/big"
	"runtime"
	"time"

	"github.com/ava-labs/avalanchego/genesis"
	"github.com/ava-labs/avalanchego/upgrade"
	corethcore "github.com/ava-labs/avalanchego/graft/coreth/core"
	cparams "github.com/ava-labs/avalanchego/graft/coreth/params"
	ccustomtypes "github.com/ava-labs/avalanchego/graft/coreth/plugin/evm/customtypes"
	avaconstants "github.com/ava-labs/avalanchego/utils/constants"
	"github.com/ava-labs/libevm/common"
	ethtypes "github.com/ava-labs/libevm/core/types"
	"github.com/ava-labs/libevm/core/state"
	"github.com/ava-labs/libevm/core/vm"
	"github.com/ava-labs/libevm/params"
	"github.com/holiman/uint256"

	"block_fetcher/statetrie"
	"block_fetcher/store"
)

// EVMContext holds the chain config needed to set up EVM execution.
type EVMContext struct {
	ChainConfig *params.ChainConfig
}

// NewEVMContext initializes the chain config (same setup as the executor).
func NewEVMContext() (*EVMContext, error) {
	config := genesis.GetConfig(avaconstants.MainnetID)
	var cChainGenesis corethcore.Genesis
	if err := json.Unmarshal([]byte(config.CChainGenesis), &cChainGenesis); err != nil {
		return nil, fmt.Errorf("parse C-Chain genesis: %w", err)
	}
	mainnetUpgrades := upgrade.GetConfig(avaconstants.MainnetID)
	setUpgrades(cChainGenesis.Config, mainnetUpgrades)
	if err := cparams.SetEthUpgrades(cChainGenesis.Config); err != nil {
		return nil, fmt.Errorf("set eth upgrades: %w", err)
	}
	return &EVMContext{ChainConfig: cChainGenesis.Config}, nil
}

// ExecuteCall runs a read-only EVM call against the state at blockNum.
func (ec *EVMContext) ExecuteCall(
	db *store.DB,
	blockNum uint64,
	from common.Address,
	to *common.Address,
	gas uint64,
	gasPrice *big.Int,
	value *big.Int,
	data []byte,
) ([]byte, uint64, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	// Read the block header for block context.
	roTx, err := db.BeginRO()
	if err != nil {
		return nil, 0, err
	}
	raw, err := store.GetBlockByNumber(roTx, db, blockNum)
	if err != nil {
		roTx.Abort()
		return nil, 0, fmt.Errorf("read block %d: %w", blockNum, err)
	}
	raw = append([]byte(nil), raw...)
	roTx.Abort()

	ethBlock, err := parseEthBlock(raw)
	if err != nil {
		return nil, 0, err
	}
	header := ethBlock.Header()

	// Set up historical state database.
	stateDB := statetrie.NewHistoricalDatabase(db, blockNum)

	sdb, err := state.New(header.Root, stateDB, nil)
	if err != nil {
		return nil, 0, fmt.Errorf("open state at block %d root %x: %w", blockNum, header.Root, err)
	}

	// Build block context.
	ccustomtypes.SetHeaderExtra(header, &ccustomtypes.HeaderExtra{})
	blockCtx := buildCallBlockContext(header, ec.ChainConfig, db)

	// Build message.
	if gas == 0 {
		gas = header.GasLimit
	}
	if gasPrice == nil {
		gasPrice = new(big.Int)
		if header.BaseFee != nil {
			gasPrice.Set(header.BaseFee)
		}
	}
	if value == nil {
		value = new(big.Int)
	}

	msg := &corethcore.Message{
		From:      from,
		To:        to,
		Nonce:     0,
		Value:     value,
		GasLimit:  gas,
		GasPrice:  gasPrice,
		GasFeeCap: gasPrice,
		GasTipCap: new(big.Int),
		Data:      data,
	}

	// Prepare and execute.
	rules := ec.ChainConfig.Rules(header.Number, cparams.IsMergeTODO, header.Time)
	sdb.Prepare(rules, from, header.Coinbase, to,
		vm.ActivePrecompiles(rules), nil)

	evm := vm.NewEVM(blockCtx, corethcore.NewEVMTxContext(msg), sdb, ec.ChainConfig, vm.Config{NoBaseFee: true})
	gp := new(corethcore.GasPool).AddGas(gas)
	result, err := corethcore.ApplyMessage(evm, msg, gp)
	if err != nil {
		return nil, 0, fmt.Errorf("apply message: %w", err)
	}
	if result.Err != nil {
		return result.ReturnData, result.UsedGas, fmt.Errorf("execution reverted: %v", result.Err)
	}
	return result.ReturnData, result.UsedGas, nil
}

func buildCallBlockContext(header *ethtypes.Header, chainCfg *params.ChainConfig, db *store.DB) vm.BlockContext {
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

	baseFee := new(big.Int)
	if header.BaseFee != nil {
		baseFee.Set(header.BaseFee)
	}

	return vm.BlockContext{
		CanTransfer: func(sdb vm.StateDB, addr common.Address, amount *uint256.Int) bool {
			return sdb.GetBalance(addr).Cmp(amount) >= 0
		},
		Transfer: func(sdb vm.StateDB, sender, recipient common.Address, amount *uint256.Int) {
			sdb.SubBalance(sender, amount)
			sdb.AddBalance(recipient, amount)
		},
		GetHash: func(n uint64) common.Hash {
			roTx, err := db.BeginRO()
			if err != nil {
				return common.Hash{}
			}
			defer roTx.Abort()
			raw, err := store.GetBlockByNumber(roTx, db, n)
			if err != nil {
				return common.Hash{}
			}
			blk, err := parseEthBlock(raw)
			if err != nil {
				return common.Hash{}
			}
			return blk.Hash()
		},
		Coinbase:    header.Coinbase,
		BlockNumber: new(big.Int).Set(header.Number),
		Time:        header.Time,
		Difficulty:  blockDifficulty,
		Random:      &blockRandom,
		GasLimit:    header.GasLimit,
		BaseFee:     baseFee,
		Header:      header,
	}
}

func setUpgrades(c *params.ChainConfig, cfg upgrade.Config) {
	extra := cparams.GetExtra(c)
	ts := func(t time.Time) *uint64 { v := uint64(t.Unix()); return &v }
	extra.NetworkUpgrades.ApricotPhase1BlockTimestamp = ts(cfg.ApricotPhase1Time)
	extra.NetworkUpgrades.ApricotPhase2BlockTimestamp = ts(cfg.ApricotPhase2Time)
	extra.NetworkUpgrades.ApricotPhase3BlockTimestamp = ts(cfg.ApricotPhase3Time)
	extra.NetworkUpgrades.ApricotPhase4BlockTimestamp = ts(cfg.ApricotPhase4Time)
	extra.NetworkUpgrades.ApricotPhase5BlockTimestamp = ts(cfg.ApricotPhase5Time)
	extra.NetworkUpgrades.ApricotPhasePre6BlockTimestamp = ts(cfg.ApricotPhasePre6Time)
	extra.NetworkUpgrades.ApricotPhase6BlockTimestamp = ts(cfg.ApricotPhase6Time)
	extra.NetworkUpgrades.ApricotPhasePost6BlockTimestamp = ts(cfg.ApricotPhasePost6Time)
	extra.NetworkUpgrades.BanffBlockTimestamp = ts(cfg.BanffTime)
	extra.NetworkUpgrades.CortinaBlockTimestamp = ts(cfg.CortinaTime)
	extra.NetworkUpgrades.DurangoBlockTimestamp = ts(cfg.DurangoTime)
	extra.NetworkUpgrades.EtnaTimestamp = ts(cfg.EtnaTime)
	cparams.WithExtra(c, extra)
}
