package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

type rpcRequest struct {
	JSONRPC string        `json:"jsonrpc"`
	ID      uint64        `json:"id"`
	Method  string        `json:"method"`
	Params  []interface{} `json:"params"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *rpcError) Error() string {
	return fmt.Sprintf("rpc error %d: %s", e.Code, e.Message)
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      uint64          `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *rpcError       `json:"error,omitempty"`
}

type RPCClient struct {
	http   *http.Client
	nextID uint64
}

func NewRPCClient() *RPCClient {
	return &RPCClient{
		http: &http.Client{
			Timeout: 15 * time.Second,
		},
	}
}

func (c *RPCClient) Call(ctx context.Context, endpoint, method string, params []interface{}, out interface{}) error {
	id := atomic.AddUint64(&c.nextID, 1)
	body, err := json.Marshal(rpcRequest{
		JSONRPC: "2.0",
		ID:      id,
		Method:  method,
		Params:  params,
	})
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}

	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("http %d: %s", resp.StatusCode, truncate(string(raw), 200))
	}

	var rr rpcResponse
	if err := json.Unmarshal(raw, &rr); err != nil {
		return fmt.Errorf("decode: %w: %s", err, truncate(string(raw), 200))
	}
	if rr.Error != nil {
		return rr.Error
	}
	if out != nil {
		if err := json.Unmarshal(rr.Result, out); err != nil {
			return fmt.Errorf("decode result: %w", err)
		}
	}
	return nil
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n] + "..."
	}
	return s
}

// --- Typed wrappers ---

func (c *RPCClient) ChainID(ctx context.Context, endpoint string) (uint64, error) {
	var hex string
	if err := c.Call(ctx, endpoint, "eth_chainId", []interface{}{}, &hex); err != nil {
		return 0, err
	}
	return parseHexUint(hex)
}

func (c *RPCClient) BlockNumber(ctx context.Context, endpoint string) (uint64, error) {
	var hex string
	if err := c.Call(ctx, endpoint, "eth_blockNumber", []interface{}{}, &hex); err != nil {
		return 0, err
	}
	return parseHexUint(hex)
}

func (c *RPCClient) GasPrice(ctx context.Context, endpoint string) (*big.Int, error) {
	var hex string
	if err := c.Call(ctx, endpoint, "eth_gasPrice", []interface{}{}, &hex); err != nil {
		return nil, err
	}
	return parseHexBigInt(hex)
}

func (c *RPCClient) Balance(ctx context.Context, endpoint, addr string) (*big.Int, error) {
	var hex string
	if err := c.Call(ctx, endpoint, "eth_getBalance", []interface{}{addr, "latest"}, &hex); err != nil {
		return nil, err
	}
	return parseHexBigInt(hex)
}

func (c *RPCClient) NonceAt(ctx context.Context, endpoint, addr, tag string) (uint64, error) {
	var hex string
	if err := c.Call(ctx, endpoint, "eth_getTransactionCount", []interface{}{addr, tag}, &hex); err != nil {
		return 0, err
	}
	return parseHexUint(hex)
}

func (c *RPCClient) SendRawTransaction(ctx context.Context, endpoint, rawHex string) (string, error) {
	var h string
	if err := c.Call(ctx, endpoint, "eth_sendRawTransaction", []interface{}{rawHex}, &h); err != nil {
		return "", err
	}
	return h, nil
}

type Block struct {
	Number               uint64
	TimestampMilliseconds int64
	TxHashes             []string
}

type rawBlock struct {
	Number               string          `json:"number"`
	TimestampMilliseconds string         `json:"timestampMilliseconds"`
	Transactions         json.RawMessage `json:"transactions"`
}

// GetBlockByNumber returns (nil, nil) when the block is not yet available
// (JSON `null` response, or Avalanche's "cannot query unfinalized data" error).
// All other RPC failures return an error.
func (c *RPCClient) GetBlockByNumber(ctx context.Context, endpoint string, num uint64) (*Block, error) {
	tag := fmt.Sprintf("0x%x", num)
	var raw json.RawMessage
	if err := c.Call(ctx, endpoint, "eth_getBlockByNumber", []interface{}{tag, false}, &raw); err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unfinalized") {
			return nil, nil
		}
		return nil, err
	}
	if len(bytes.TrimSpace(raw)) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	var rb rawBlock
	if err := json.Unmarshal(raw, &rb); err != nil {
		return nil, fmt.Errorf("decode block: %w", err)
	}
	return parseBlock(&rb)
}

func (c *RPCClient) GetLatestBlock(ctx context.Context, endpoint string) (*Block, error) {
	var rb rawBlock
	if err := c.Call(ctx, endpoint, "eth_getBlockByNumber", []interface{}{"latest", false}, &rb); err != nil {
		return nil, err
	}
	return parseBlock(&rb)
}

func parseBlock(rb *rawBlock) (*Block, error) {
	if rb.TimestampMilliseconds == "" {
		return nil, fmt.Errorf("block missing timestampMilliseconds")
	}
	tsMs, err := parseHexInt64(rb.TimestampMilliseconds)
	if err != nil {
		return nil, fmt.Errorf("timestampMilliseconds: %w", err)
	}
	n, err := parseHexUint(rb.Number)
	if err != nil {
		return nil, fmt.Errorf("number: %w", err)
	}
	var hashes []string
	if len(rb.Transactions) > 0 {
		if err := json.Unmarshal(rb.Transactions, &hashes); err != nil {
			return nil, fmt.Errorf("transactions: %w", err)
		}
	}
	return &Block{
		Number:                n,
		TimestampMilliseconds: tsMs,
		TxHashes:              hashes,
	}, nil
}


func parseHexUint(s string) (uint64, error) {
	s = strings.TrimPrefix(s, "0x")
	if s == "" {
		return 0, fmt.Errorf("empty hex")
	}
	v := new(big.Int)
	if _, ok := v.SetString(s, 16); !ok {
		return 0, fmt.Errorf("invalid hex: %q", s)
	}
	if !v.IsUint64() {
		return 0, fmt.Errorf("hex value out of uint64 range: %q", s)
	}
	return v.Uint64(), nil
}

func parseHexInt64(s string) (int64, error) {
	s = strings.TrimPrefix(s, "0x")
	if s == "" {
		return 0, fmt.Errorf("empty hex")
	}
	v := new(big.Int)
	if _, ok := v.SetString(s, 16); !ok {
		return 0, fmt.Errorf("invalid hex: %q", s)
	}
	if !v.IsInt64() {
		return 0, fmt.Errorf("hex value out of int64 range: %q", s)
	}
	return v.Int64(), nil
}

func parseHexBigInt(s string) (*big.Int, error) {
	s = strings.TrimPrefix(s, "0x")
	if s == "" {
		return nil, fmt.Errorf("empty hex")
	}
	v := new(big.Int)
	if _, ok := v.SetString(s, 16); !ok {
		return nil, fmt.Errorf("invalid hex: %q", s)
	}
	return v, nil
}
