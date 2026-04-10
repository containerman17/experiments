package lightnode

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"runtime"
	"sync"

	"github.com/ava-labs/avalanchego/genesis"
	corethcore "github.com/ava-labs/avalanchego/graft/coreth/core"
	cparams "github.com/ava-labs/avalanchego/graft/coreth/params"
	ccustomtypes "github.com/ava-labs/avalanchego/graft/coreth/plugin/evm/customtypes"
	avaconstants "github.com/ava-labs/avalanchego/utils/constants"
	proposerblock "github.com/ava-labs/avalanchego/vms/proposervm/block"
	"github.com/ava-labs/libevm/common"
	"github.com/ava-labs/libevm/core/types"
	"github.com/ava-labs/libevm/core/vm"
	"github.com/ava-labs/libevm/params"
	"github.com/ava-labs/libevm/rlp"
	"github.com/holiman/uint256"

	"block_fetcher/store"
)

var registerOnce sync.Once

func registerExtras() {
	registerOnce.Do(func() {
		// Only register type extras, NOT corethcore.RegisterExtras() which
		// installs a VM hook that type-asserts StateDB to *state.StateDB.
		// Our historicalState implements vm.StateDB but isn't that concrete type.
		// This matches defi-toolbox-avalanche's lightclient approach.
		cparams.RegisterExtras()
		ccustomtypes.Register()
	})
}

// Config holds configuration for opening a Node.
type Config struct {
	DataDir string // MDBX data directory
	NodeURI string // Avalanche node URI for peer discovery (not needed for queries, only sync)
}

// Node provides ethclient.Client-compatible read methods backed by MDBX historical state.
type Node struct {
	db       *store.DB
	chainCfg *params.ChainConfig
}

// New opens an MDBX database and loads chain config from the C-Chain genesis.
// It does NOT start syncing.
func New(cfg Config) (*Node, error) {
	registerExtras()

	db, err := store.Open(cfg.DataDir)
	if err != nil {
		return nil, fmt.Errorf("open mdbx: %w", err)
	}

	// Load chain config from genesis.
	config := genesis.GetConfig(avaconstants.MainnetID)
	var cChainGenesis corethcore.Genesis
	if err := json.Unmarshal([]byte(config.CChainGenesis), &cChainGenesis); err != nil {
		db.Close()
		return nil, fmt.Errorf("parse C-Chain genesis: %w", err)
	}
	if err := cparams.SetEthUpgrades(cChainGenesis.Config); err != nil {
		db.Close()
		return nil, fmt.Errorf("set eth upgrades: %w", err)
	}

	return &Node{
		db:       db,
		chainCfg: cChainGenesis.Config,
	}, nil
}

// Close closes the underlying MDBX database.
func (n *Node) Close() error {
	n.db.Close()
	return nil
}

// resolveBlockNumber returns the block number to use. If blockNumber is nil,
// returns the head block number.
func (n *Node) resolveBlockNumber(blockNumber *big.Int) (uint64, error) {
	if blockNumber != nil {
		return blockNumber.Uint64(), nil
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	tx, err := n.db.BeginRO()
	if err != nil {
		return 0, err
	}
	defer tx.Abort()

	head, ok := store.GetHeadBlock(tx, n.db)
	if !ok {
		return 0, fmt.Errorf("no head block in database")
	}
	return head, nil
}

// BlockNumber returns the most recent block number.
func (n *Node) BlockNumber(ctx context.Context) (uint64, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	tx, err := n.db.BeginRO()
	if err != nil {
		return 0, err
	}
	defer tx.Abort()

	head, ok := store.GetHeadBlock(tx, n.db)
	if !ok {
		return 0, fmt.Errorf("no head block in database")
	}
	return head, nil
}

// BalanceAt returns the balance of the account at the given block number.
func (n *Node) BalanceAt(ctx context.Context, account common.Address, blockNumber *big.Int) (*big.Int, error) {
	num, err := n.resolveBlockNumber(blockNumber)
	if err != nil {
		return nil, err
	}

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	tx, err := n.db.BeginRO()
	if err != nil {
		return nil, err
	}
	defer tx.Abort()

	var addr20 [20]byte
	copy(addr20[:], account[:])

	acct, err := store.LookupHistoricalAccount(tx, n.db, addr20, num)
	if err != nil {
		return nil, err
	}
	if acct == nil {
		return new(big.Int), nil
	}

	bal := new(uint256.Int).SetBytes32(acct.Balance[:])
	return bal.ToBig(), nil
}

// NonceAt returns the nonce of the account at the given block number.
func (n *Node) NonceAt(ctx context.Context, account common.Address, blockNumber *big.Int) (uint64, error) {
	num, err := n.resolveBlockNumber(blockNumber)
	if err != nil {
		return 0, err
	}

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	tx, err := n.db.BeginRO()
	if err != nil {
		return 0, err
	}
	defer tx.Abort()

	var addr20 [20]byte
	copy(addr20[:], account[:])

	acct, err := store.LookupHistoricalAccount(tx, n.db, addr20, num)
	if err != nil {
		return 0, err
	}
	if acct == nil {
		return 0, nil
	}
	return acct.Nonce, nil
}

// CodeAt returns the contract code of the given account at the given block number.
// Note: code is immutable per codeHash, so we look up the historical account's
// codeHash and fetch the code from the current code table.
func (n *Node) CodeAt(ctx context.Context, account common.Address, blockNumber *big.Int) ([]byte, error) {
	num, err := n.resolveBlockNumber(blockNumber)
	if err != nil {
		return nil, err
	}

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	tx, err := n.db.BeginRO()
	if err != nil {
		return nil, err
	}
	defer tx.Abort()

	var addr20 [20]byte
	copy(addr20[:], account[:])

	acct, err := store.LookupHistoricalAccount(tx, n.db, addr20, num)
	if err != nil {
		return nil, err
	}
	if acct == nil {
		return nil, nil
	}
	if acct.CodeHash == store.EmptyCodeHash || acct.CodeHash == [32]byte{} {
		return nil, nil
	}

	code, err := store.GetCode(tx, n.db, acct.CodeHash)
	if err != nil {
		return nil, err
	}
	return code, nil
}

// StorageAt returns the value of a storage slot at the given block number.
func (n *Node) StorageAt(ctx context.Context, account common.Address, key common.Hash, blockNumber *big.Int) ([]byte, error) {
	num, err := n.resolveBlockNumber(blockNumber)
	if err != nil {
		return nil, err
	}

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	tx, err := n.db.BeginRO()
	if err != nil {
		return nil, err
	}
	defer tx.Abort()

	var addr20 [20]byte
	var slot32 [32]byte
	copy(addr20[:], account[:])
	copy(slot32[:], key[:])

	val, err := store.LookupHistoricalStorage(tx, n.db, addr20, slot32, num)
	if err != nil {
		return nil, err
	}
	return val[:], nil
}

// HeaderByNumber returns the block header for the given block number.
func (n *Node) HeaderByNumber(ctx context.Context, number *big.Int) (*types.Header, error) {
	num, err := n.resolveBlockNumber(number)
	if err != nil {
		return nil, err
	}

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	tx, err := n.db.BeginRO()
	if err != nil {
		return nil, err
	}
	defer tx.Abort()

	raw, err := store.GetBlockByNumber(tx, n.db, num)
	if err != nil {
		return nil, fmt.Errorf("get block %d: %w", num, err)
	}

	block, err := parseEthBlock(raw)
	if err != nil {
		return nil, fmt.Errorf("parse block %d: %w", num, err)
	}

	return block.Header(), nil
}

// CallContract executes a contract call against historical state.
func (n *Node) CallContract(ctx context.Context, msg CallMsg, blockNumber *big.Int) ([]byte, error) {
	num, err := n.resolveBlockNumber(blockNumber)
	if err != nil {
		return nil, err
	}

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	tx, err := n.db.BeginRO()
	if err != nil {
		return nil, err
	}
	defer tx.Abort()

	// Get block header for EVM context.
	raw, err := store.GetBlockByNumber(tx, n.db, num)
	if err != nil {
		return nil, fmt.Errorf("get block %d: %w", num, err)
	}
	block, err := parseEthBlock(raw)
	if err != nil {
		return nil, fmt.Errorf("parse block %d: %w", num, err)
	}
	header := block.Header()

	// Set Avalanche header extras.
	ccustomtypes.SetHeaderExtra(header, &ccustomtypes.HeaderExtra{})

	// Build block context.
	getHashFn := func(n uint64) common.Hash { return common.Hash{} }
	blockCtx := buildBlockContext(header, n.chainCfg, getHashFn)

	// Build historical statedb.
	statedb := newHistoricalState(tx, n.db, num)

	// Build tx context from the call message.
	gas := msg.Gas
	if gas == 0 {
		gas = 50_000_000
	}

	var to *common.Address
	if msg.To != nil {
		addr := *msg.To
		to = &addr
	}

	gasPrice := msg.GasPrice
	if gasPrice == nil {
		gasPrice = new(big.Int)
	}
	value := msg.Value
	if value == nil {
		value = new(big.Int)
	}

	txCtx := vm.TxContext{
		Origin:   msg.From,
		GasPrice: gasPrice,
	}

	// Prepare statedb for the call.
	rules := n.chainCfg.Rules(header.Number, cparams.IsMergeTODO, header.Time)
	statedb.Prepare(rules, msg.From, header.Coinbase, to,
		vm.ActivePrecompiles(rules), nil)

	// Create EVM via NewEVM. This triggers coreth's hook which wraps the StateDB.
	// Our statedb must be a real *state.StateDB (backed by statetrie.HistoricalDatabase).
	evm := vm.NewEVM(blockCtx, txCtx, statedb, n.chainCfg, vm.Config{NoBaseFee: true})

	result, err := corethcore.ApplyMessage(evm, &corethcore.Message{
		From:              msg.From,
		To:                to,
		Nonce:             statedb.GetNonce(msg.From),
		Value:             value,
		GasLimit:          gas,
		GasPrice:          gasPrice,
		GasFeeCap:         msg.GasFeeCap,
		GasTipCap:         msg.GasTipCap,
		Data:              msg.Data,
		AccessList:        nil,
		SkipAccountChecks: true,
	}, new(corethcore.GasPool).AddGas(gas))
	if err != nil {
		return nil, fmt.Errorf("evm execution: %w", err)
	}
	if result.Err != nil {
		return result.ReturnData, result.Err
	}
	return result.ReturnData, nil
}

// CallMsg mirrors ethereum.CallMsg to avoid importing the interfaces package
// which may conflict. We accept the same fields.
type CallMsg struct {
	From      common.Address
	To        *common.Address
	Gas       uint64
	GasPrice  *big.Int
	GasFeeCap *big.Int
	GasTipCap *big.Int
	Value     *big.Int
	Data      []byte
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

	baseFee := header.BaseFee
	if baseFee == nil {
		baseFee = new(big.Int)
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
		BaseFee:     baseFee,
		Header:      header,
	}
}
