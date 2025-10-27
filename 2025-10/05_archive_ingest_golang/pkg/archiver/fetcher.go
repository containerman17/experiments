package archiver

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

type FetcherOptions struct {
	RpcURL           string
	IncludeTraces    bool
	RpcConcurrency   int
	DebugConcurrency int
	PrefetchWindow   int
	StartBlock       int64
}

type Fetcher struct {
	rpcURL           string
	includeTraces    bool
	prefetchWindow   int
	blockBuffer      map[int64]*NormalizedBlock
	nextBlockToWrite int64
	activeFetches    map[int64]bool
	latestBlock      int64
	startTime        time.Time
	startBlock       int64

	// Concurrency control
	rpcLimit   chan struct{}
	debugLimit chan struct{}

	// HTTP client
	httpClient *http.Client

	// Mutex for thread-safe map access
	mu sync.Mutex
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
	if opts.PrefetchWindow == 0 {
		opts.PrefetchWindow = 500
	}
	if opts.StartBlock == 0 {
		opts.StartBlock = 1
	}

	return &Fetcher{
		rpcURL:           opts.RpcURL,
		includeTraces:    opts.IncludeTraces,
		prefetchWindow:   opts.PrefetchWindow,
		blockBuffer:      make(map[int64]*NormalizedBlock),
		activeFetches:    make(map[int64]bool),
		nextBlockToWrite: opts.StartBlock,
		startBlock:       opts.StartBlock,
		rpcLimit:         make(chan struct{}, opts.RpcConcurrency),
		debugLimit:       make(chan struct{}, opts.DebugConcurrency),
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

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	var rpcResp jsonRpcResponse
	if err := json.Unmarshal(body, &rpcResp); err != nil {
		return nil, fmt.Errorf("failed to unmarshal response: %w", err)
	}

	if rpcResp.Error != nil {
		return nil, fmt.Errorf("RPC error: %s", rpcResp.Error.Message)
	}

	return rpcResp.Result, nil
}

func (f *Fetcher) getLatestBlock() (int64, error) {
	result, err := f.rpcCall("eth_blockNumber", []interface{}{})
	if err != nil {
		return 0, err
	}

	var blockNumHex string
	if err := json.Unmarshal(result, &blockNumHex); err != nil {
		return 0, fmt.Errorf("failed to unmarshal block number: %w", err)
	}

	var blockNum int64
	if _, err := fmt.Sscanf(blockNumHex, "0x%x", &blockNum); err != nil {
		return 0, fmt.Errorf("failed to parse block number: %w", err)
	}

	return blockNum, nil
}

func (f *Fetcher) getBlock(blockNum int64) (json.RawMessage, []string, error) {
	blockNumHex := fmt.Sprintf("0x%x", blockNum)
	result, err := f.rpcCall("eth_getBlockByNumber", []interface{}{blockNumHex, true})
	if err != nil {
		return nil, nil, err
	}

	// Extract transaction hashes
	var blockData struct {
		Transactions []struct {
			Hash string `json:"hash"`
		} `json:"transactions"`
	}
	if err := json.Unmarshal(result, &blockData); err != nil {
		return nil, nil, fmt.Errorf("failed to extract tx hashes: %w", err)
	}

	txHashes := make([]string, len(blockData.Transactions))
	for i, tx := range blockData.Transactions {
		txHashes[i] = tx.Hash
	}

	return result, txHashes, nil
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

func (f *Fetcher) fetchBlockData(blockNum int64) (*NormalizedBlock, error) {
	// Acquire RPC semaphore for block fetch
	f.rpcLimit <- struct{}{}
	blockData, txHashes, err := f.getBlock(blockNum)
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
			var traceResults []json.RawMessage
			if err := json.Unmarshal(blockTraces, &traceResults); err != nil {
				return nil, fmt.Errorf("failed to unmarshal block traces: %w", err)
			}

			traces = make([]TraceResultOptional, len(traceResults))
			for i, traceResult := range traceResults {
				var ct *CallTrace
				if len(traceResult) > 0 && string(traceResult) != "null" {
					var parsedTrace CallTrace
					if err := json.Unmarshal(traceResult, &parsedTrace); err == nil {
						ct = &parsedTrace
					}
				}
				traces[i] = TraceResultOptional{
					TxHash: txHashes[i],
					Result: ct,
				}
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
						if err := json.Unmarshal(traceResult, &parsedTrace); err == nil {
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

	// Parse the block to get our Block structure
	var block Block
	if err := json.Unmarshal(blockData, &block); err != nil {
		return nil, fmt.Errorf("failed to unmarshal block: %w", err)
	}

	return &NormalizedBlock{
		Block:    block,
		Traces:   traces,
		Receipts: json.RawMessage(receiptsJSON),
	}, nil
}

func isPrecompileError(err error) bool {
	if err == nil {
		return false
	}
	errMsg := err.Error()
	return contains(errMsg, "incorrect number of top-level calls")
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > len(substr) && findSubstring(s, substr))
}

func findSubstring(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

func (f *Fetcher) Start() error {
	// Get latest block
	latestBlock, err := f.getLatestBlock()
	if err != nil {
		return fmt.Errorf("failed to get latest block: %w", err)
	}

	f.latestBlock = latestBlock
	f.startTime = time.Now()

	fmt.Printf("Starting from block %d\n", f.nextBlockToWrite)
	fmt.Printf("Latest block: %d, prefetch window: %d\n", f.latestBlock, f.prefetchWindow)

	for {
		// Update latest block if we've caught up
		if f.nextBlockToWrite > f.latestBlock {
			time.Sleep(1 * time.Second)
			latestBlock, err := f.getLatestBlock()
			if err != nil {
				fmt.Printf("Error getting latest block: %v\n", err)
				continue
			}
			f.latestBlock = latestBlock
			continue
		}

		// Start fetches for blocks within the prefetch window
		windowEnd := f.nextBlockToWrite + int64(f.prefetchWindow) - 1
		if windowEnd > f.latestBlock {
			windowEnd = f.latestBlock
		}

		for blockNum := f.nextBlockToWrite; blockNum <= windowEnd; blockNum++ {
			f.mu.Lock()
			inBuffer := f.blockBuffer[blockNum] != nil
			isActive := f.activeFetches[blockNum]
			f.mu.Unlock()

			if !inBuffer && !isActive {
				f.mu.Lock()
				f.activeFetches[blockNum] = true
				f.mu.Unlock()

				go func(bn int64) {
					block, err := f.fetchBlockData(bn)
					if err != nil {
						fmt.Printf("Failed to fetch block %d: %v\n", bn, err)
						f.mu.Lock()
						delete(f.activeFetches, bn)
						f.mu.Unlock()
						// Will retry on next iteration
						return
					}

					f.mu.Lock()
					f.blockBuffer[bn] = block
					delete(f.activeFetches, bn)
					f.mu.Unlock()
				}(blockNum)
			}
		}

		// Check if next sequential block is ready
		f.mu.Lock()
		nextBlock := f.blockBuffer[f.nextBlockToWrite]
		f.mu.Unlock()

		if nextBlock == nil {
			time.Sleep(10 * time.Millisecond)
			continue
		}

		// Block is ready, remove from buffer
		f.mu.Lock()
		delete(f.blockBuffer, f.nextBlockToWrite)
		f.mu.Unlock()

		// Here you would write the block to storage
		// For now, we'll just print progress
		if f.nextBlockToWrite%100 == 0 {
			blocksProcessed := f.nextBlockToWrite - f.startBlock
			timeElapsedSec := time.Since(f.startTime).Seconds()
			blocksPerSec := float64(blocksProcessed) / timeElapsedSec
			remaining := f.latestBlock - f.nextBlockToWrite
			hoursLeft := (float64(remaining) / blocksPerSec) / 3600

			fmt.Printf("Block %d | Remaining: %d | Speed: %.0f bl/s | ETA: %.2f hours\n",
				f.nextBlockToWrite, remaining, blocksPerSec, hoursLeft)
		}

		f.nextBlockToWrite++
	}
}
