package archiver

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

type FetcherOptions struct {
	RpcURL           string
	IncludeTraces    bool
	RpcConcurrency   int
	DebugConcurrency int
}

type Fetcher struct {
	rpcURL        string
	includeTraces bool

	// Concurrency control
	rpcLimit   chan struct{}
	debugLimit chan struct{}

	// HTTP client
	httpClient *http.Client
}

type jsonRpcRequest struct {
	Jsonrpc string        `json:"jsonrpc"`
	Method  string        `json:"method"`
	Params  []interface{} `json:"params"`
	ID      int           `json:"id"`
}

type jsonRpcResponse struct {
	Jsonrpc string          `json:"jsonrpc"`
	ID      int             `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *jsonRpcError   `json:"error,omitempty"`
}

type jsonRpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func NewFetcher(opts FetcherOptions) *Fetcher {
	if opts.RpcConcurrency == 0 {
		opts.RpcConcurrency = 300
	}
	if opts.DebugConcurrency == 0 {
		opts.DebugConcurrency = 40
	}

	return &Fetcher{
		rpcURL:        opts.RpcURL,
		includeTraces: opts.IncludeTraces,
		rpcLimit:      make(chan struct{}, opts.RpcConcurrency),
		debugLimit:    make(chan struct{}, opts.DebugConcurrency),
		httpClient: &http.Client{
			Timeout: 5 * time.Minute,
		},
	}
}

func (f *Fetcher) rpcCall(method string, params []interface{}) (json.RawMessage, error) {
	reqBody := jsonRpcRequest{
		Jsonrpc: "2.0",
		Method:  method,
		Params:  params,
		ID:      1,
	}

	jsonData, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	req, err := http.NewRequest("POST", f.rpcURL, bytes.NewBuffer(jsonData))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")

	resp, err := f.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to make request: %w", err)
	}
	defer resp.Body.Close()

	var rpcResp jsonRpcResponse
	decoder := json.NewDecoder(resp.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&rpcResp); err != nil {
		return nil, fmt.Errorf("failed to unmarshal response: %w", err)
	}

	if rpcResp.Error != nil {
		return nil, fmt.Errorf("RPC error: %s", rpcResp.Error.Message)
	}

	return rpcResp.Result, nil
}

func (f *Fetcher) GetLatestBlock() (int64, error) {
	result, err := f.rpcCall("eth_blockNumber", []interface{}{})
	if err != nil {
		return 0, err
	}

	var blockNumHex string
	decoder := json.NewDecoder(bytes.NewReader(result))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&blockNumHex); err != nil {
		return 0, fmt.Errorf("failed to unmarshal block number: %w", err)
	}

	var blockNum int64
	if _, err := fmt.Sscanf(blockNumHex, "0x%x", &blockNum); err != nil {
		return 0, fmt.Errorf("failed to parse block number: %w", err)
	}

	return blockNum, nil
}

func (f *Fetcher) getBlock(blockNum int64) (*Block, []string, error) {
	blockNumHex := fmt.Sprintf("0x%x", blockNum)
	result, err := f.rpcCall("eth_getBlockByNumber", []interface{}{blockNumHex, true})
	if err != nil {
		return nil, nil, err
	}

	// Parse the block structure
	var block Block
	decoder := json.NewDecoder(bytes.NewReader(result))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&block); err != nil {
		return nil, nil, fmt.Errorf("failed to unmarshal block: %w", err)
	}

	// Extract transaction hashes from fully parsed transactions
	txHashes := make([]string, len(block.Transactions))
	for i, tx := range block.Transactions {
		txHashes[i] = tx.Hash
	}

	return &block, txHashes, nil
}

func (f *Fetcher) getReceipt(txHash string) (json.RawMessage, error) {
	return f.rpcCall("eth_getTransactionReceipt", []interface{}{txHash})
}

func (f *Fetcher) traceBlockByNumber(blockNum int64) (json.RawMessage, error) {
	blockNumHex := fmt.Sprintf("0x%x", blockNum)
	return f.rpcCall("debug_traceBlockByNumber", []interface{}{blockNumHex, map[string]string{"tracer": "callTracer"}})
}

func (f *Fetcher) traceTransaction(txHash string) (json.RawMessage, error) {
	return f.rpcCall("debug_traceTransaction", []interface{}{txHash, map[string]string{"tracer": "callTracer"}})
}

func (f *Fetcher) FetchBlockData(blockNum int64) (*NormalizedBlock, error) {
	// Acquire RPC semaphore for block fetch
	f.rpcLimit <- struct{}{}
	block, txHashes, err := f.getBlock(blockNum)
	<-f.rpcLimit

	if err != nil {
		return nil, fmt.Errorf("failed to get block %d: %w", blockNum, err)
	}

	// Fetch all receipts in parallel
	receipts := make([]json.RawMessage, len(txHashes))
	var wg sync.WaitGroup
	var receiptErr error
	var receiptMu sync.Mutex

	for i, txHash := range txHashes {
		wg.Add(1)
		go func(idx int, hash string) {
			defer wg.Done()

			f.rpcLimit <- struct{}{}
			receipt, err := f.getReceipt(hash)
			<-f.rpcLimit

			if err != nil {
				receiptMu.Lock()
				if receiptErr == nil {
					receiptErr = fmt.Errorf("failed to get receipt for tx %s: %w", hash, err)
				}
				receiptMu.Unlock()
				return
			}

			receipts[idx] = receipt
		}(i, txHash)
	}

	wg.Wait()

	if receiptErr != nil {
		return nil, receiptErr
	}

	// Marshal receipts array
	receiptsJSON, err := json.Marshal(receipts)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal receipts: %w", err)
	}

	// Fetch traces if enabled
	var traces []TraceResultOptional
	if f.includeTraces && len(txHashes) > 0 {
		// Try block-level trace first
		f.debugLimit <- struct{}{}
		blockTraces, err := f.traceBlockByNumber(blockNum)
		<-f.debugLimit

		if err == nil {
			// Successfully got block traces, parse into array
			// This RPC returns a custom format: [{txHash, result}, ...]
			decoder := json.NewDecoder(bytes.NewReader(blockTraces))
			decoder.DisallowUnknownFields()
			if err := decoder.Decode(&traces); err != nil {
				return nil, fmt.Errorf("failed to unmarshal block traces: %w", err)
			}
		} else {
			// Block trace failed, fall back to per-transaction tracing
			fmt.Printf("Block %d trace failed, falling back to per-tx tracing: %v\n", blockNum, err)

			traces = make([]TraceResultOptional, len(txHashes))
			var traceMu sync.Mutex
			var traceWg sync.WaitGroup

			for i, txHash := range txHashes {
				traceWg.Add(1)
				go func(idx int, hash string) {
					defer traceWg.Done()

					f.debugLimit <- struct{}{}
					traceResult, err := f.traceTransaction(hash)
					<-f.debugLimit

					traceMu.Lock()
					defer traceMu.Unlock()

					if err != nil {
						// Check for "incorrect number of top-level calls" error
						if isPrecompileError(err) {
							fmt.Printf("Trace failed for tx %s (precompile), treating as nil trace\n", hash)
							traces[idx] = TraceResultOptional{
								TxHash: hash,
								Result: nil,
							}
							return
						}
						// For other errors, log but continue
						fmt.Printf("Failed to trace tx %s: %v\n", hash, err)
						traces[idx] = TraceResultOptional{
							TxHash: hash,
							Result: nil,
						}
						return
					}

					var ct *CallTrace
					if len(traceResult) > 0 && string(traceResult) != "null" {
						var parsedTrace CallTrace
						decoder := json.NewDecoder(bytes.NewReader(traceResult))
						decoder.DisallowUnknownFields()
						if err := decoder.Decode(&parsedTrace); err == nil {
							ct = &parsedTrace
						}
					}

					traces[idx] = TraceResultOptional{
						TxHash: hash,
						Result: ct,
					}
				}(i, txHash)
			}

			traceWg.Wait()
		}
	}

	return &NormalizedBlock{
		Block:    *block,
		Traces:   traces,
		Receipts: json.RawMessage(receiptsJSON),
	}, nil
}

func isPrecompileError(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "incorrect number of top-level calls")
}
