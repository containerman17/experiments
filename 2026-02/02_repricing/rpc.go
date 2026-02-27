package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ava-labs/libevm/common"
	"github.com/ava-labs/libevm/core/types"
	"github.com/holiman/uint256"
)

const (
	hardcodedRPCWSURL     = "ws://127.0.0.1:9650/ext/bc/C/ws"
	wsParallelConnections = 64
	rpcMaxRetries         = 10
	rpcRetryMinBackoff    = 1 * time.Second
	rpcRetryMaxBackoff    = 10 * time.Second
)

var (
	sharedWSPool     *wsPool
	sharedWSPoolErr  error
	sharedWSPoolOnce sync.Once
)

// RPCClient handles strict JSON-RPC calls over a shared websocket pool.
type RPCClient struct {
	parentBlock uint64
	wsPool      *wsPool

	rpcCalls atomic.Int64
	rpcErrs  atomic.Int64
}

type callTraceNode struct {
	To    string          `json:"to"`
	Calls []callTraceNode `json:"calls"`
}

func getSharedWSPool() *wsPool {
	sharedWSPoolOnce.Do(func() {
		sharedWSPool, sharedWSPoolErr = newWSPool(hardcodedRPCWSURL, wsParallelConnections)
	})
	if sharedWSPoolErr != nil {
		panic(fmt.Errorf("ws pool init failed (%s): %w", hardcodedRPCWSURL, sharedWSPoolErr))
	}
	return sharedWSPool
}

func NewRPCClient(parentBlock uint64) *RPCClient {
	return &RPCClient{
		parentBlock: parentBlock,
		wsPool:      getSharedWSPool(),
	}
}

func (c *RPCClient) FetchStorage(addr common.Address, slot common.Hash) common.Hash {
	result, err := c.rpcCall("eth_getStorageAt", addr.Hex(), slot.Hex(), fmt.Sprintf("0x%x", c.parentBlock))
	if err != nil {
		c.rpcErrs.Add(1)
		panic(fmt.Errorf("state fetch failed: storage addr=%s slot=%s block=%d: %w", addr.Hex(), slot.Hex(), c.parentBlock, err))
	}
	return common.HexToHash(result)
}

func (c *RPCClient) FetchCode(addr common.Address) []byte {
	result, err := c.rpcCall("eth_getCode", addr.Hex(), fmt.Sprintf("0x%x", c.parentBlock))
	if err != nil {
		c.rpcErrs.Add(1)
		panic(fmt.Errorf("state fetch failed: code addr=%s block=%d: %w", addr.Hex(), c.parentBlock, err))
	}
	code, _ := hex.DecodeString(strings.TrimPrefix(result, "0x"))
	return code
}

func (c *RPCClient) FetchBalance(addr common.Address) *uint256.Int {
	result, err := c.rpcCall("eth_getBalance", addr.Hex(), fmt.Sprintf("0x%x", c.parentBlock))
	if err != nil {
		c.rpcErrs.Add(1)
		panic(fmt.Errorf("state fetch failed: balance addr=%s block=%d: %w", addr.Hex(), c.parentBlock, err))
	}
	val := new(uint256.Int)
	val.SetFromHex(result)
	return val
}

func (c *RPCClient) FetchNonce(addr common.Address) uint64 {
	result, err := c.rpcCall("eth_getTransactionCount", addr.Hex(), fmt.Sprintf("0x%x", c.parentBlock))
	if err != nil {
		c.rpcErrs.Add(1)
		panic(fmt.Errorf("state fetch failed: nonce addr=%s block=%d: %w", addr.Hex(), c.parentBlock, err))
	}
	n := new(big.Int)
	n.SetString(strings.TrimPrefix(result, "0x"), 16)
	return n.Uint64()
}

func (c *RPCClient) FetchBlockHash(num uint64) common.Hash {
	result, err := c.rpcCall("eth_getBlockByNumber", fmt.Sprintf("0x%x", num), false)
	if err != nil {
		panic(fmt.Errorf("state fetch failed: block hash num=%d: %w", num, err))
	}
	if result == "null" {
		panic(fmt.Errorf("state fetch failed: block hash num=%d: rpc returned null", num))
	}
	var block struct {
		Hash string `json:"hash"`
	}
	if err := json.Unmarshal([]byte(result), &block); err != nil {
		panic(fmt.Errorf("state fetch failed: unmarshal block hash num=%d: %w", num, err))
	}
	if block.Hash == "" {
		panic(fmt.Errorf("state fetch failed: empty block hash num=%d", num))
	}
	return common.HexToHash(block.Hash)
}

func (c *RPCClient) TraceTouchesSystemPrecompile(txHash string) (bool, error) {
	raw, err := c.rpcCallRaw("debug_traceTransaction", txHash, map[string]interface{}{"tracer": "callTracer"})
	if err != nil {
		return false, err
	}
	if string(raw) == "null" {
		return false, nil
	}
	var root callTraceNode
	if err := json.Unmarshal(raw, &root); err != nil {
		return false, err
	}
	return traceHasSystemPrecompile(root), nil
}

func traceHasSystemPrecompile(node callTraceNode) bool {
	if node.To != "" {
		if isAvalancheSystemPrecompile(common.HexToAddress(node.To)) {
			return true
		}
	}
	for _, child := range node.Calls {
		if traceHasSystemPrecompile(child) {
			return true
		}
	}
	return false
}

// FetchBlock fetches a block with full transactions and its receipts.
func (c *RPCClient) FetchBlock(blockNum uint64) (*BlockData, error) {
	hexBlock := fmt.Sprintf("0x%x", blockNum)

	blockJSON, err := c.rpcCallRaw("eth_getBlockByNumber", hexBlock, true)
	if err != nil {
		return nil, fmt.Errorf("fetch block %d: %w", blockNum, err)
	}
	if string(blockJSON) == "null" {
		return nil, fmt.Errorf("fetch block %d: rpc returned null block", blockNum)
	}

	receiptsJSON, err := c.rpcCallRaw("eth_getBlockReceipts", hexBlock)
	if err != nil {
		return nil, fmt.Errorf("fetch block receipts %d: %w", blockNum, err)
	}
	if string(receiptsJSON) == "null" {
		return nil, fmt.Errorf("fetch block receipts %d: rpc returned null", blockNum)
	}

	return &BlockData{BlockJSON: blockJSON, ReceiptsJSON: receiptsJSON}, nil
}

// rpcCall makes a JSON-RPC call and returns the string result.
func (c *RPCClient) rpcCall(method string, params ...interface{}) (string, error) {
	raw, err := c.rpcCallRaw(method, params...)
	if err != nil {
		return "", err
	}

	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s, nil
	}
	return string(raw), nil
}

// rpcCallRaw returns raw JSON result.
func (c *RPCClient) rpcCallRaw(method string, params ...interface{}) (json.RawMessage, error) {
	c.rpcCalls.Add(1)
	var lastErr error
	for attempt := 0; attempt <= rpcMaxRetries; attempt++ {
		raw, err := c.wsPool.callRaw(method, params...)
		if err == nil {
			return raw, nil
		}
		lastErr = err
		c.rpcErrs.Add(1)
		if attempt == rpcMaxRetries {
			break
		}
		time.Sleep(retryBackoff(attempt))
	}
	return nil, fmt.Errorf("rpc %s failed after %d retries: %w", method, rpcMaxRetries, lastErr)
}

func retryBackoff(attempt int) time.Duration {
	backoff := rpcRetryMinBackoff << attempt
	if backoff > rpcRetryMaxBackoff {
		return rpcRetryMaxBackoff
	}
	return backoff
}

// BlockData holds block + receipts JSON.
type BlockData struct {
	BlockJSON    json.RawMessage `json:"block"`
	ReceiptsJSON json.RawMessage `json:"receipts"`
}

func LoadOrFetchBlock(rpc *RPCClient, blockNum uint64, cacheDir string) (*BlockData, error) {
	_ = cacheDir // cache intentionally disabled
	return rpc.FetchBlock(blockNum)
}

// ParseBlock parses a BlockData into typed structures.
func ParseBlock(bd *BlockData, chainID *big.Int) (*types.Header, []*types.Transaction, []TxReceipt, error) {
	// Parse header
	var rawBlock struct {
		Number        string            `json:"number"`
		Hash          string            `json:"hash"`
		ParentHash    string            `json:"parentHash"`
		Timestamp     string            `json:"timestamp"`
		GasLimit      string            `json:"gasLimit"`
		GasUsed       string            `json:"gasUsed"`
		BaseFeePerGas string            `json:"baseFeePerGas"`
		Miner         string            `json:"miner"`
		Difficulty    string            `json:"difficulty"`
		Transactions  []json.RawMessage `json:"transactions"`
	}
	if err := json.Unmarshal(bd.BlockJSON, &rawBlock); err != nil {
		return nil, nil, nil, fmt.Errorf("parse block: %w", err)
	}

	header := &types.Header{
		Number:     hexToBigInt(rawBlock.Number),
		ParentHash: common.HexToHash(rawBlock.ParentHash),
		Time:       hexToUint64(rawBlock.Timestamp),
		GasLimit:   hexToUint64(rawBlock.GasLimit),
		GasUsed:    hexToUint64(rawBlock.GasUsed),
		BaseFee:    hexToBigInt(rawBlock.BaseFeePerGas),
		Coinbase:   common.HexToAddress(rawBlock.Miner),
		Difficulty: hexToBigInt(rawBlock.Difficulty),
	}

	// Parse transactions
	signer := types.NewLondonSigner(chainID)
	var txs []*types.Transaction
	for _, rawTx := range rawBlock.Transactions {
		tx := new(types.Transaction)
		if err := tx.UnmarshalJSON(rawTx); err != nil {
			return nil, nil, nil, fmt.Errorf("parse tx: %w", err)
		}
		// Verify we can recover the sender
		_, err := types.Sender(signer, tx)
		if err != nil {
			return nil, nil, nil, fmt.Errorf("recover sender for tx %s: %w", tx.Hash().Hex(), err)
		}
		txs = append(txs, tx)
	}

	// Parse receipts
	var rawReceipts []json.RawMessage
	if err := json.Unmarshal(bd.ReceiptsJSON, &rawReceipts); err != nil {
		return nil, nil, nil, fmt.Errorf("parse receipts array: %w", err)
	}

	var receipts []TxReceipt
	for _, rr := range rawReceipts {
		var r TxReceipt
		if err := json.Unmarshal(rr, &r); err != nil {
			return nil, nil, nil, fmt.Errorf("parse receipt: %w", err)
		}
		receipts = append(receipts, r)
	}

	return header, txs, receipts, nil
}

// TxReceipt is a minimal receipt for comparison.
type TxReceipt struct {
	TxHash            string            `json:"transactionHash"`
	Status            string            `json:"status"`
	GasUsed           string            `json:"gasUsed"`
	CumulativeGasUsed string            `json:"cumulativeGasUsed"`
	LogCount          int               `json:"-"`
	Logs              []json.RawMessage `json:"logs"`
}

func (r TxReceipt) StatusUint() uint64 {
	if r.Status == "0x1" {
		return 1
	}
	return 0
}

func hexToUint64(s string) uint64 {
	n := new(big.Int)
	n.SetString(strings.TrimPrefix(s, "0x"), 16)
	return n.Uint64()
}

func hexToBigInt(s string) *big.Int {
	if s == "" {
		return new(big.Int)
	}
	n := new(big.Int)
	n.SetString(strings.TrimPrefix(s, "0x"), 16)
	return n
}
