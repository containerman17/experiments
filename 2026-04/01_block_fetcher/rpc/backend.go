package rpc

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math/big"
	"runtime"

	"github.com/ava-labs/libevm/common"
	"github.com/ava-labs/libevm/common/hexutil"
	ethtypes "github.com/ava-labs/libevm/core/types"
	"github.com/ava-labs/libevm/rlp"
	"github.com/erigontech/mdbx-go/mdbx"
	proposerblock "github.com/ava-labs/avalanchego/vms/proposervm/block"

	"block_fetcher/store"
)

// Backend provides data access for RPC methods.
type Backend struct {
	db  *store.DB
	evm *EVMContext
}

// NewBackend creates a new RPC backend.
func NewBackend(db *store.DB) *Backend {
	evmCtx, err := NewEVMContext()
	if err != nil {
		panic(fmt.Sprintf("failed to initialize EVM context: %v", err))
	}
	return &Backend{db: db, evm: evmCtx}
}

// BlockNumber returns the latest block number.
func (b *Backend) BlockNumber() (string, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	tx, err := b.db.BeginRO()
	if err != nil {
		return "", err
	}
	defer tx.Abort()

	head, ok := store.GetHeadBlock(tx, b.db)
	if !ok {
		return "0x0", nil
	}
	return fmt.Sprintf("0x%x", head), nil
}

// GetBlockByNumber returns block data by number.
func (b *Backend) GetBlockByNumber(params []json.RawMessage) (any, error) {
	if len(params) < 1 {
		return nil, fmt.Errorf("missing block number parameter")
	}
	var blockTag string
	if err := json.Unmarshal(params[0], &blockTag); err != nil {
		return nil, fmt.Errorf("invalid block number: %w", err)
	}
	fullTx := false
	if len(params) > 1 {
		json.Unmarshal(params[1], &fullTx)
	}

	blockNum, err := b.resolveBlockTag(blockTag)
	if err != nil {
		return nil, err
	}

	return b.getBlock(blockNum, fullTx)
}

// GetBlockByHash returns block data by hash.
func (b *Backend) GetBlockByHash(params []json.RawMessage) (any, error) {
	if len(params) < 1 {
		return nil, fmt.Errorf("missing block hash parameter")
	}
	var hashHex string
	if err := json.Unmarshal(params[0], &hashHex); err != nil {
		return nil, fmt.Errorf("invalid block hash: %w", err)
	}
	fullTx := false
	if len(params) > 1 {
		json.Unmarshal(params[1], &fullTx)
	}

	hash := common.HexToHash(hashHex)

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	tx, err := b.db.BeginRO()
	if err != nil {
		return nil, err
	}
	defer tx.Abort()

	val, err := tx.Get(b.db.BlockHashIndex, hash[:])
	if err != nil {
		if mdbx.IsNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	if len(val) < 8 {
		return nil, nil
	}
	blockNum := binary.BigEndian.Uint64(val)
	tx.Abort()
	runtime.UnlockOSThread()

	return b.getBlock(blockNum, fullTx)
}

// GetTransactionByHash returns a transaction by hash.
func (b *Backend) GetTransactionByHash(params []json.RawMessage) (any, error) {
	if len(params) < 1 {
		return nil, fmt.Errorf("missing tx hash parameter")
	}
	var hashHex string
	if err := json.Unmarshal(params[0], &hashHex); err != nil {
		return nil, fmt.Errorf("invalid tx hash: %w", err)
	}
	txHash := common.HexToHash(hashHex)

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	tx, err := b.db.BeginRO()
	if err != nil {
		return nil, err
	}
	defer tx.Abort()

	blockNum, txIndex, err := store.GetTxLocation(tx, b.db, [32]byte(txHash))
	if err != nil {
		if mdbx.IsNotFound(err) {
			return nil, nil
		}
		return nil, err
	}

	raw, err := store.GetBlockByNumber(tx, b.db, blockNum)
	if err != nil {
		return nil, err
	}
	raw = append([]byte(nil), raw...)
	tx.Abort()
	runtime.UnlockOSThread()

	ethBlock, err := parseEthBlock(raw)
	if err != nil {
		return nil, err
	}
	txs := ethBlock.Transactions()
	if int(txIndex) >= len(txs) {
		return nil, nil
	}
	return formatTransaction(txs[txIndex], ethBlock, int(txIndex)), nil
}

// GetTransactionReceipt returns a transaction receipt from stored data.
func (b *Backend) GetTransactionReceipt(params []json.RawMessage) (any, error) {
	if len(params) < 1 {
		return nil, fmt.Errorf("missing tx hash parameter")
	}
	var hashHex string
	if err := json.Unmarshal(params[0], &hashHex); err != nil {
		return nil, fmt.Errorf("invalid tx hash: %w", err)
	}
	txHash := common.HexToHash(hashHex)

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	tx, err := b.db.BeginRO()
	if err != nil {
		return nil, err
	}
	defer tx.Abort()

	blockNum, txIndex, err := store.GetTxLocation(tx, b.db, [32]byte(txHash))
	if err != nil {
		if mdbx.IsNotFound(err) {
			return nil, nil
		}
		return nil, err
	}

	// Read block for hash and transaction data.
	raw, err := store.GetBlockByNumber(tx, b.db, blockNum)
	if err != nil {
		return nil, err
	}
	ethBlock, err := parseEthBlock(append([]byte(nil), raw...))
	if err != nil {
		return nil, err
	}

	// Read stored receipts.
	receipts, err := store.ReadBlockReceipts(tx, b.db, blockNum)
	if err != nil {
		return nil, err
	}
	if receipts == nil || int(txIndex) >= len(receipts) {
		return nil, fmt.Errorf("receipt not available for block %d tx %d", blockNum, txIndex)
	}

	return formatReceipt(receipts[txIndex], txIndex, blockNum, ethBlock), nil
}

// GetBalance returns the balance of an address at a block.
func (b *Backend) GetBalance(params []json.RawMessage) (any, error) {
	if len(params) < 1 {
		return nil, fmt.Errorf("missing address parameter")
	}
	var addrHex, blockTag string
	if err := json.Unmarshal(params[0], &addrHex); err != nil {
		return nil, err
	}
	if len(params) > 1 {
		json.Unmarshal(params[1], &blockTag)
	}
	if blockTag == "" {
		blockTag = "latest"
	}

	addr := common.HexToAddress(addrHex)
	blockNum, err := b.resolveBlockTag(blockTag)
	if err != nil {
		return nil, err
	}

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	tx, err := b.db.BeginRO()
	if err != nil {
		return nil, err
	}
	defer tx.Abort()

	acct, err := b.getAccountAt(tx, addr, blockNum)
	if err != nil {
		return nil, err
	}
	if acct == nil {
		return "0x0", nil
	}
	bal := new(big.Int).SetBytes(acct.Balance[:])
	return fmt.Sprintf("0x%x", bal), nil
}

// GetStorageAt returns a storage value at a block.
func (b *Backend) GetStorageAt(params []json.RawMessage) (any, error) {
	if len(params) < 2 {
		return nil, fmt.Errorf("missing parameters")
	}
	var addrHex, slotHex, blockTag string
	if err := json.Unmarshal(params[0], &addrHex); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(params[1], &slotHex); err != nil {
		return nil, err
	}
	if len(params) > 2 {
		json.Unmarshal(params[2], &blockTag)
	}
	if blockTag == "" {
		blockTag = "latest"
	}

	addr := common.HexToAddress(addrHex)
	slot := common.HexToHash(slotHex)
	blockNum, err := b.resolveBlockTag(blockTag)
	if err != nil {
		return nil, err
	}

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	tx, err := b.db.BeginRO()
	if err != nil {
		return nil, err
	}
	defer tx.Abort()

	head, _ := store.GetHeadBlock(tx, b.db)
	if blockNum >= head {
		// Current state — read flat storage.
		val, err := store.GetStorage(tx, b.db, [20]byte(addr), [32]byte(slot))
		if err != nil {
			return nil, err
		}
		return fmt.Sprintf("0x%064x", val), nil
	}

	// Historical state.
	val, err := store.LookupHistoricalStorage(tx, b.db, [20]byte(addr), [32]byte(slot), blockNum)
	if err != nil {
		return nil, err
	}
	return fmt.Sprintf("0x%064x", val), nil
}

// GetCode returns the code at an address.
func (b *Backend) GetCode(params []json.RawMessage) (any, error) {
	if len(params) < 1 {
		return nil, fmt.Errorf("missing address parameter")
	}
	var addrHex, blockTag string
	if err := json.Unmarshal(params[0], &addrHex); err != nil {
		return nil, err
	}
	if len(params) > 1 {
		json.Unmarshal(params[1], &blockTag)
	}
	if blockTag == "" {
		blockTag = "latest"
	}

	addr := common.HexToAddress(addrHex)
	blockNum, err := b.resolveBlockTag(blockTag)
	if err != nil {
		return nil, err
	}

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	tx, err := b.db.BeginRO()
	if err != nil {
		return nil, err
	}
	defer tx.Abort()

	acct, err := b.getAccountAt(tx, addr, blockNum)
	if err != nil {
		return nil, err
	}
	if acct == nil {
		return "0x", nil
	}
	if acct.CodeHash == store.EmptyCodeHash {
		return "0x", nil
	}
	code, err := store.GetCode(tx, b.db, acct.CodeHash)
	if err != nil {
		return nil, err
	}
	if code == nil {
		return "0x", nil
	}
	return hexutil.Encode(code), nil
}

// GetTransactionCount returns the nonce of an address at a block.
func (b *Backend) GetTransactionCount(params []json.RawMessage) (any, error) {
	if len(params) < 1 {
		return nil, fmt.Errorf("missing address parameter")
	}
	var addrHex, blockTag string
	if err := json.Unmarshal(params[0], &addrHex); err != nil {
		return nil, err
	}
	if len(params) > 1 {
		json.Unmarshal(params[1], &blockTag)
	}
	if blockTag == "" {
		blockTag = "latest"
	}

	addr := common.HexToAddress(addrHex)
	blockNum, err := b.resolveBlockTag(blockTag)
	if err != nil {
		return nil, err
	}

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	tx, err := b.db.BeginRO()
	if err != nil {
		return nil, err
	}
	defer tx.Abort()

	acct, err := b.getAccountAt(tx, addr, blockNum)
	if err != nil {
		return nil, err
	}
	if acct == nil {
		return "0x0", nil
	}
	return fmt.Sprintf("0x%x", acct.Nonce), nil
}

// GetLogs returns logs matching a filter.
func (b *Backend) GetLogs(params []json.RawMessage) (any, error) {
	if len(params) < 1 {
		return nil, fmt.Errorf("missing filter parameter")
	}
	var filter LogFilter
	if err := json.Unmarshal(params[0], &filter); err != nil {
		return nil, fmt.Errorf("invalid filter: %w", err)
	}

	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	tx, err := b.db.BeginRO()
	if err != nil {
		return nil, err
	}
	defer tx.Abort()

	head, _ := store.GetHeadBlock(tx, b.db)

	fromBlock, err := resolveFilterBlock(filter.FromBlock, head)
	if err != nil {
		return nil, err
	}
	toBlock, err := resolveFilterBlock(filter.ToBlock, head)
	if err != nil {
		return nil, err
	}
	if toBlock-fromBlock > 10000 {
		return nil, fmt.Errorf("block range too large: %d blocks (max 10000)", toBlock-fromBlock)
	}

	// TODO: use bitmap indexes for filtered queries.
	// For now, brute force scan the block range.
	var results []map[string]any
	for blockNum := fromBlock; blockNum <= toBlock; blockNum++ {
		receipts, err := store.ReadBlockReceipts(tx, b.db, blockNum)
		if err != nil || receipts == nil {
			continue
		}
		// Get block hash for response.
		raw, err := store.GetBlockByNumber(tx, b.db, blockNum)
		if err != nil {
			continue
		}
		ethBlock, err := parseEthBlock(append([]byte(nil), raw...))
		if err != nil {
			continue
		}
		blockHash := ethBlock.Hash()

		logIndex := 0
		for txIdx, r := range receipts {
			for _, l := range r.Logs {
				if filter.matchesLog(l) {
					results = append(results, formatLogFromReceipt(l, uint16(txIdx), uint16(logIndex), blockNum, blockHash, r.TxHash))
				}
				logIndex++
			}
		}
		if len(results) > 10000 {
			return nil, fmt.Errorf("too many results: >10000 logs")
		}
	}
	return results, nil
}

// CallArgs matches the standard eth_call params.
type CallArgs struct {
	From     *string `json:"from"`
	To       *string `json:"to"`
	Gas      *string `json:"gas"`
	GasPrice *string `json:"gasPrice"`
	Value    *string `json:"value"`
	Data     *string `json:"data"`
	Input    *string `json:"input"` // alias for data
}

// Call executes a read-only call against historical state.
func (b *Backend) Call(params []json.RawMessage) (any, error) {
	if len(params) < 1 {
		return nil, fmt.Errorf("missing call params")
	}
	var args CallArgs
	if err := json.Unmarshal(params[0], &args); err != nil {
		return nil, fmt.Errorf("invalid call args: %w", err)
	}
	blockTag := "latest"
	if len(params) > 1 {
		json.Unmarshal(params[1], &blockTag)
	}

	blockNum, err := b.resolveBlockTag(blockTag)
	if err != nil {
		return nil, err
	}

	from := common.Address{}
	if args.From != nil {
		from = common.HexToAddress(*args.From)
	}
	var to *common.Address
	if args.To != nil {
		addr := common.HexToAddress(*args.To)
		to = &addr
	}
	var gas uint64
	if args.Gas != nil {
		gas, _ = hexutil.DecodeUint64(*args.Gas)
	}
	var gasPrice *big.Int
	if args.GasPrice != nil {
		gasPrice, _ = hexutil.DecodeBig(*args.GasPrice)
	}
	var value *big.Int
	if args.Value != nil {
		value, _ = hexutil.DecodeBig(*args.Value)
	}
	dataHex := args.Data
	if dataHex == nil {
		dataHex = args.Input
	}
	var data []byte
	if dataHex != nil {
		data, _ = hexutil.Decode(*dataHex)
	}

	result, _, err := b.evm.ExecuteCall(b.db, blockNum, from, to, gas, gasPrice, value, data)
	if err != nil {
		// Return revert data in the error response for compatibility.
		if len(result) > 0 {
			return nil, fmt.Errorf("execution reverted: %s", hexutil.Encode(result))
		}
		return nil, err
	}
	return hexutil.Encode(result), nil
}

// EstimateGas estimates gas for a call using binary search.
func (b *Backend) EstimateGas(params []json.RawMessage) (any, error) {
	if len(params) < 1 {
		return nil, fmt.Errorf("missing call params")
	}
	var args CallArgs
	if err := json.Unmarshal(params[0], &args); err != nil {
		return nil, fmt.Errorf("invalid call args: %w", err)
	}
	blockTag := "latest"
	if len(params) > 1 {
		json.Unmarshal(params[1], &blockTag)
	}

	blockNum, err := b.resolveBlockTag(blockTag)
	if err != nil {
		return nil, err
	}

	from := common.Address{}
	if args.From != nil {
		from = common.HexToAddress(*args.From)
	}
	var to *common.Address
	if args.To != nil {
		addr := common.HexToAddress(*args.To)
		to = &addr
	}
	var gasPrice *big.Int
	if args.GasPrice != nil {
		gasPrice, _ = hexutil.DecodeBig(*args.GasPrice)
	}
	var value *big.Int
	if args.Value != nil {
		value, _ = hexutil.DecodeBig(*args.Value)
	}
	dataHex := args.Data
	if dataHex == nil {
		dataHex = args.Input
	}
	var data []byte
	if dataHex != nil {
		data, _ = hexutil.Decode(*dataHex)
	}

	// Binary search for minimum gas.
	lo := uint64(21000)
	hi := uint64(8_000_000)
	if args.Gas != nil {
		if g, err := hexutil.DecodeUint64(*args.Gas); err == nil && g > 0 {
			hi = g
		}
	}

	// First check if it works at hi.
	_, _, err = b.evm.ExecuteCall(b.db, blockNum, from, to, hi, gasPrice, value, data)
	if err != nil {
		return nil, err
	}

	// Binary search.
	for lo+1 < hi {
		mid := (lo + hi) / 2
		_, _, err = b.evm.ExecuteCall(b.db, blockNum, from, to, mid, gasPrice, value, data)
		if err != nil {
			lo = mid
		} else {
			hi = mid
		}
	}

	return fmt.Sprintf("0x%x", hi), nil
}

// GasPrice returns a gas price suggestion.
func (b *Backend) GasPrice() (string, error) {
	return "0x5d21dba00", nil // 25 nAVAX default
}

// FeeHistory returns fee history data.
func (b *Backend) FeeHistory(params []json.RawMessage) (any, error) {
	return nil, fmt.Errorf("eth_feeHistory not yet implemented")
}

// --- Helper methods ---

func (b *Backend) resolveBlockTag(tag string) (uint64, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	tx, err := b.db.BeginRO()
	if err != nil {
		return 0, err
	}
	defer tx.Abort()

	head, _ := store.GetHeadBlock(tx, b.db)

	switch tag {
	case "latest", "pending", "safe", "finalized":
		return head, nil
	case "earliest":
		return 0, nil
	default:
		n, err := hexutil.DecodeUint64(tag)
		if err != nil {
			return 0, fmt.Errorf("invalid block tag: %s", tag)
		}
		return n, nil
	}
}

func (b *Backend) getAccountAt(tx *mdbx.Txn, addr common.Address, blockNum uint64) (*store.Account, error) {
	head, _ := store.GetHeadBlock(tx, b.db)
	var a20 [20]byte
	copy(a20[:], addr[:])

	if blockNum >= head {
		return store.GetAccount(tx, b.db, a20)
	}
	return store.LookupHistoricalAccount(tx, b.db, a20, blockNum)
}

func (b *Backend) getBlock(blockNum uint64, fullTx bool) (any, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	tx, err := b.db.BeginRO()
	if err != nil {
		return nil, err
	}
	defer tx.Abort()

	raw, err := store.GetBlockByNumber(tx, b.db, blockNum)
	if err != nil {
		if mdbx.IsNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	raw = append([]byte(nil), raw...)
	tx.Abort()
	runtime.UnlockOSThread()

	ethBlock, err := parseEthBlock(raw)
	if err != nil {
		return nil, err
	}

	return formatBlock(ethBlock, fullTx), nil
}

func parseEthBlock(raw []byte) (*ethtypes.Block, error) {
	if blk, err := proposerblock.ParseWithoutVerification(raw); err == nil {
		ethBlock := new(ethtypes.Block)
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
	ethBlock := new(ethtypes.Block)
	if err := rlp.DecodeBytes(rawBlock, ethBlock); err != nil {
		return nil, fmt.Errorf("decode pre-fork eth block: %w", err)
	}
	return ethBlock, nil
}
