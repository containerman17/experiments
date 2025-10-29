package rpc

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

type Transaction struct {
	Hash                 string          `json:"hash"`
	Nonce                string          `json:"nonce"`
	BlockHash            string          `json:"blockHash"`
	BlockNumber          string          `json:"blockNumber"`
	TransactionIndex     string          `json:"transactionIndex"`
	From                 string          `json:"from"`
	To                   string          `json:"to"`
	Value                string          `json:"value"`
	Gas                  string          `json:"gas"`
	GasPrice             string          `json:"gasPrice"`
	Input                string          `json:"input"`
	V                    string          `json:"v,omitempty"`
	R                    string          `json:"r,omitempty"`
	S                    string          `json:"s,omitempty"`
	YParity              string          `json:"yParity,omitempty"`
	Type                 string          `json:"type,omitempty"`
	TypeHex              string          `json:"typeHex,omitempty"`
	ChainId              string          `json:"chainId,omitempty"`
	MaxFeePerGas         string          `json:"maxFeePerGas,omitempty"`
	MaxPriorityFeePerGas string          `json:"maxPriorityFeePerGas,omitempty"`
	AccessList           json.RawMessage `json:"accessList,omitempty"`
}

type Block struct {
	Number                string        `json:"number"`
	Hash                  string        `json:"hash"`
	ParentHash            string        `json:"parentHash"`
	Timestamp             string        `json:"timestamp"`
	Miner                 string        `json:"miner"`
	Difficulty            string        `json:"difficulty"`
	TotalDifficulty       string        `json:"totalDifficulty"`
	Size                  string        `json:"size"`
	GasLimit              string        `json:"gasLimit"`
	GasUsed               string        `json:"gasUsed"`
	BaseFeePerGas         string        `json:"baseFeePerGas,omitempty"`
	BlockGasCost          string        `json:"blockGasCost,omitempty"`
	Transactions          []Transaction `json:"transactions"`
	StateRoot             string        `json:"stateRoot"`
	TransactionsRoot      string        `json:"transactionsRoot"`
	ReceiptsRoot          string        `json:"receiptsRoot"`
	ExtraData             string        `json:"extraData,omitempty"`
	BlockExtraData        string        `json:"blockExtraData,omitempty"`
	ExtDataHash           string        `json:"extDataHash,omitempty"`
	ExtDataGasUsed        string        `json:"extDataGasUsed,omitempty"`
	LogsBloom             string        `json:"logsBloom"`
	MixHash               string        `json:"mixHash"`
	Nonce                 string        `json:"nonce"`
	Sha3Uncles            string        `json:"sha3Uncles"`
	Uncles                []string      `json:"uncles"`
	BlobGasUsed           string        `json:"blobGasUsed,omitempty"`
	ExcessBlobGas         string        `json:"excessBlobGas,omitempty"`
	ParentBeaconBlockRoot string        `json:"parentBeaconBlockRoot,omitempty"`
}

type CallTrace struct {
	From         string      `json:"from"`
	Gas          string      `json:"gas"`
	GasUsed      string      `json:"gasUsed"`
	To           string      `json:"to"`
	Input        string      `json:"input"`
	Output       string      `json:"output,omitempty"`
	Error        string      `json:"error,omitempty"`
	RevertReason string      `json:"revertReason,omitempty"`
	Calls        []CallTrace `json:"calls,omitempty"`
	Value        string      `json:"value,omitempty"`
	Type         string      `json:"type"`
}

type NormalizedBlock struct {
	Block    Block                 `json:"block"`
	Traces   []TraceResultOptional `json:"traces"`
	Receipts json.RawMessage       `json:"receipts"`
}

type TraceResultOptional struct {
	TxHash string     `json:"txHash"`
	Result *CallTrace `json:"result"`
}

type ProgressCallback func(phase string, current, total int64, txCount int)

type FetcherOptions struct {
	RpcURL           string
	RpcConcurrency   int              // Number of concurrent batch requests
	DebugConcurrency int              // Number of concurrent debug batch requests
	BatchSize        int              // Number of requests per batch
	DebugBatchSize   int              // Number of debug requests per batch
	MaxRetries       int              // Maximum number of retries per request
	RetryDelay       time.Duration    // Initial retry delay
	ProgressCallback ProgressCallback // Optional progress callback
}

type Fetcher struct {
	rpcURL         string
	batchSize      int
	debugBatchSize int
	maxRetries     int
	retryDelay     time.Duration
	progressCb     ProgressCallback

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

// txInfo holds information about a transaction and its location
type txInfo struct {
	hash     string
	blockNum int64
	blockIdx int
	txIdx    int
}

func NewFetcher(opts FetcherOptions) *Fetcher {
	if opts.RpcConcurrency == 0 {
		opts.RpcConcurrency = 10 // Conservative default for concurrent batches
	}
	if opts.DebugConcurrency == 0 {
		opts.DebugConcurrency = 2 // Very conservative for debug batches
	}
	if opts.BatchSize == 0 {
		opts.BatchSize = 100
	}
	if opts.DebugBatchSize == 0 {
		opts.DebugBatchSize = 10
	}
	if opts.MaxRetries == 0 {
		opts.MaxRetries = 3
	}
	if opts.RetryDelay == 0 {
		opts.RetryDelay = 500 * time.Millisecond
	}

	// Create HTTP client with proper connection pooling
	// Node.js reuses connections aggressively, so we do the same
	transport := &http.Transport{
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 100, // Default is only 2!
		IdleConnTimeout:     90 * time.Second,
		DisableKeepAlives:   false,
		DialContext: (&net.Dialer{
			Timeout:   30 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
	}

	return &Fetcher{
		rpcURL:         opts.RpcURL,
		batchSize:      opts.BatchSize,
		debugBatchSize: opts.DebugBatchSize,
		maxRetries:     opts.MaxRetries,
		retryDelay:     opts.RetryDelay,
		progressCb:     opts.ProgressCallback,
		rpcLimit:       make(chan struct{}, opts.RpcConcurrency),
		debugLimit:     make(chan struct{}, opts.DebugConcurrency),
		httpClient: &http.Client{
			Timeout:   5 * time.Minute,
			Transport: transport,
		},
	}
}

// batchRpcCall sends a batch of JSON-RPC requests with retry logic
func (f *Fetcher) batchRpcCall(requests []jsonRpcRequest) ([]jsonRpcResponse, error) {
	if len(requests) == 0 {
		return []jsonRpcResponse{}, nil
	}

	jsonData, err := json.Marshal(requests)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal batch request: %w", err)
	}

	var responses []jsonRpcResponse
	var lastErr error

	for attempt := 0; attempt <= f.maxRetries; attempt++ {
		if attempt > 0 {
			delay := f.retryDelay * time.Duration(1<<uint(attempt-1))
			if delay > 10*time.Second {
				delay = 10 * time.Second
			}
			fmt.Printf("WARNING: Batch request failed: %v. Retrying (attempt %d/%d) after %v\n", lastErr, attempt, f.maxRetries, delay)
			time.Sleep(delay)
		}

		req, err := http.NewRequest("POST", f.rpcURL, bytes.NewBuffer(jsonData))
		if err != nil {
			return nil, fmt.Errorf("failed to create request: %w", err)
		}

		req.Header.Set("Content-Type", "application/json")

		resp, err := f.httpClient.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("failed to make batch request: %w", err)
			continue
		}

		decoder := json.NewDecoder(resp.Body)
		decoder.DisallowUnknownFields()
		err = decoder.Decode(&responses)
		resp.Body.Close()

		if err != nil {
			lastErr = fmt.Errorf("failed to unmarshal batch response: %w", err)
			continue
		}

		// Validate responses
		if len(responses) != len(requests) {
			lastErr = fmt.Errorf("batch response count mismatch: sent %d, got %d", len(requests), len(responses))
			continue
		}

		// Sort responses by ID to match request order
		sort.Slice(responses, func(i, j int) bool {
			return responses[i].ID < responses[j].ID
		})

		// Validate all responses and check for errors
		validationErr := false
		for i, resp := range responses {
			if resp.ID != requests[i].ID {
				lastErr = fmt.Errorf("batch response ID mismatch at index %d: expected %d, got %d", i, requests[i].ID, resp.ID)
				validationErr = true
				break
			}
			if resp.Error != nil {
				return nil, fmt.Errorf("RPC error in batch at index %d (ID %d): %s", i, resp.ID, resp.Error.Message)
			}
			if len(resp.Result) == 0 {
				return nil, fmt.Errorf("empty result in batch response at index %d (ID %d)", i, resp.ID)
			}
		}

		if validationErr {
			continue
		}

		return responses, nil
	}

	return nil, fmt.Errorf("batch request failed after %d retries: %w", f.maxRetries, lastErr)
}

// batchRpcCallDebug is like batchRpcCall but uses debug concurrency limit
func (f *Fetcher) batchRpcCallDebug(requests []jsonRpcRequest) ([]jsonRpcResponse, error) {
	if len(requests) == 0 {
		return []jsonRpcResponse{}, nil
	}

	jsonData, err := json.Marshal(requests)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal debug batch request: %w", err)
	}

	var responses []jsonRpcResponse
	var lastErr error

	for attempt := 0; attempt <= f.maxRetries; attempt++ {
		if attempt > 0 {
			delay := f.retryDelay * time.Duration(1<<uint(attempt-1))
			if delay > 10*time.Second {
				delay = 10 * time.Second
			}
			fmt.Printf("WARNING: Debug batch request failed: %v. Retrying (attempt %d/%d) after %v\n", lastErr, attempt, f.maxRetries, delay)
			time.Sleep(delay)
		}

		req, err := http.NewRequest("POST", f.rpcURL, bytes.NewBuffer(jsonData))
		if err != nil {
			return nil, fmt.Errorf("failed to create debug request: %w", err)
		}

		req.Header.Set("Content-Type", "application/json")

		resp, err := f.httpClient.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("failed to make debug batch request: %w", err)
			continue
		}

		decoder := json.NewDecoder(resp.Body)
		decoder.DisallowUnknownFields()
		err = decoder.Decode(&responses)
		resp.Body.Close()

		if err != nil {
			lastErr = fmt.Errorf("failed to unmarshal debug batch response: %w", err)
			continue
		}

		// Sort responses by ID to match request order
		sort.Slice(responses, func(i, j int) bool {
			return responses[i].ID < responses[j].ID
		})

		// For debug calls, we allow some errors (like precompile errors) but still validate structure
		if len(responses) != len(requests) {
			lastErr = fmt.Errorf("debug batch response count mismatch: sent %d, got %d", len(requests), len(responses))
			continue
		}

		validationErr := false
		for i, resp := range responses {
			if resp.ID != requests[i].ID {
				lastErr = fmt.Errorf("debug batch response ID mismatch at index %d: expected %d, got %d", i, requests[i].ID, resp.ID)
				validationErr = true
				break
			}
		}

		if validationErr {
			continue
		}

		return responses, nil
	}

	return nil, fmt.Errorf("debug batch request failed after %d retries: %w", f.maxRetries, lastErr)
}

func (f *Fetcher) GetLatestBlock() (int64, error) {
	requests := []jsonRpcRequest{
		{
			Jsonrpc: "2.0",
			Method:  "eth_blockNumber",
			Params:  []interface{}{},
			ID:      1,
		},
	}

	f.rpcLimit <- struct{}{}
	responses, err := f.batchRpcCall(requests)
	<-f.rpcLimit

	if err != nil {
		return 0, err
	}

	var blockNumHex string
	decoder := json.NewDecoder(bytes.NewReader(responses[0].Result))
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

// chunksOf splits a slice into chunks of specified size
func chunksOf[T any](items []T, size int) [][]T {
	if size <= 0 {
		panic("chunk size must be positive")
	}

	var chunks [][]T
	for i := 0; i < len(items); i += size {
		end := i + size
		if end > len(items) {
			end = len(items)
		}
		chunks = append(chunks, items[i:end])
	}
	return chunks
}

// FetchBlockRange fetches all blocks in the range [from, to] inclusive using batch operations
func (f *Fetcher) FetchBlockRange(from, to int64) ([]*NormalizedBlock, error) {
	if from > to {
		return nil, fmt.Errorf("invalid range: from %d > to %d", from, to)
	}

	// Batch fetch all blocks
	blocks, err := f.fetchBlocksBatch(from, to)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch blocks: %w", err)
	}

	// Collect all transaction hashes with their block numbers
	var allTxs []txInfo

	for blockIdx, block := range blocks {
		blockNum := from + int64(blockIdx)
		for txIdx, tx := range block.Transactions {
			allTxs = append(allTxs, txInfo{
				hash:     tx.Hash,
				blockNum: blockNum,
				blockIdx: blockIdx,
				txIdx:    txIdx,
			})
		}
	}

	// Batch fetch all receipts
	var receiptsMap map[string]json.RawMessage
	if len(allTxs) > 0 {
		receiptsMap, err = f.fetchReceiptsBatch(allTxs)
		if err != nil {
			return nil, fmt.Errorf("failed to fetch receipts: %w", err)
		}
	} else {
		receiptsMap = make(map[string]json.RawMessage)
	}

	// Batch fetch all traces
	var tracesMap map[string]*TraceResultOptional
	if len(allTxs) > 0 {
		tracesMap, err = f.fetchTracesBatch(from, to, allTxs)
		if err != nil {
			return nil, fmt.Errorf("failed to fetch traces: %w", err)
		}
	} else {
		tracesMap = make(map[string]*TraceResultOptional)
	}

	// Assemble normalized blocks
	result := make([]*NormalizedBlock, len(blocks))
	for i := range blocks {
		blockNum := from + int64(i)

		// Collect receipts for this block
		receipts := make([]json.RawMessage, len(blocks[i].Transactions))
		traces := make([]TraceResultOptional, len(blocks[i].Transactions))

		for j, tx := range blocks[i].Transactions {
			receipt, ok := receiptsMap[tx.Hash]
			if !ok {
				return nil, fmt.Errorf("missing receipt for tx %s in block %d", tx.Hash, blockNum)
			}
			receipts[j] = receipt

			trace, ok := tracesMap[tx.Hash]
			if ok && trace != nil {
				traces[j] = *trace
			} else {
				traces[j] = TraceResultOptional{
					TxHash: tx.Hash,
					Result: nil,
				}
			}
		}

		receiptsJSON, err := json.Marshal(receipts)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal receipts for block %d: %w", blockNum, err)
		}

		result[i] = &NormalizedBlock{
			Block:    blocks[i],
			Receipts: json.RawMessage(receiptsJSON),
			Traces:   traces,
		}
	}

	return result, nil
}

func (f *Fetcher) fetchBlocksBatch(from, to int64) ([]Block, error) {
	numBlocks := int(to - from + 1)
	blocks := make([]Block, numBlocks)

	// Create all block requests
	var allRequests []jsonRpcRequest
	for i := int64(0); i < int64(numBlocks); i++ {
		blockNum := from + i
		allRequests = append(allRequests, jsonRpcRequest{
			Jsonrpc: "2.0",
			Method:  "eth_getBlockByNumber",
			Params:  []interface{}{fmt.Sprintf("0x%x", blockNum), true}, // true for full transactions
			ID:      int(i),
		})
	}

	// Split into batches and execute concurrently
	batches := chunksOf(allRequests, f.batchSize)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var batchErr error
	var completedBlocks int64

	for batchIdx, batch := range batches {
		wg.Add(1)
		go func(idx int, requests []jsonRpcRequest) {
			defer wg.Done()

			f.rpcLimit <- struct{}{}
			responses, err := f.batchRpcCall(requests)
			<-f.rpcLimit

			if err != nil {
				mu.Lock()
				if batchErr == nil {
					batchErr = fmt.Errorf("batch %d failed: %w", idx, err)
				}
				mu.Unlock()
				return
			}

			// Parse block responses
			batchTxCount := 0
			for _, resp := range responses {
				var block Block
				decoder := json.NewDecoder(bytes.NewReader(resp.Result))
				decoder.DisallowUnknownFields()
				if err := decoder.Decode(&block); err != nil {
					mu.Lock()
					if batchErr == nil {
						batchErr = fmt.Errorf("failed to unmarshal block at index %d: %w", resp.ID, err)
					}
					mu.Unlock()
					return
				}

				batchTxCount += len(block.Transactions)
				mu.Lock()
				blocks[resp.ID] = block
				mu.Unlock()
			}

			// Report progress
			mu.Lock()
			completedBlocks += int64(len(responses))
			if f.progressCb != nil {
				f.progressCb("blocks", completedBlocks, int64(numBlocks), batchTxCount)
			}
			mu.Unlock()
		}(batchIdx, batch)
	}

	wg.Wait()

	if batchErr != nil {
		return nil, batchErr
	}

	return blocks, nil
}

func (f *Fetcher) fetchReceiptsBatch(txInfos []txInfo) (map[string]json.RawMessage, error) {
	receiptsMap := make(map[string]json.RawMessage)
	var mu sync.Mutex

	// Create all receipt requests
	var allRequests []jsonRpcRequest
	txHashToIdx := make(map[int]string) // Map request ID to tx hash

	for i, tx := range txInfos {
		allRequests = append(allRequests, jsonRpcRequest{
			Jsonrpc: "2.0",
			Method:  "eth_getTransactionReceipt",
			Params:  []interface{}{tx.hash},
			ID:      i,
		})
		txHashToIdx[i] = tx.hash
	}

	// Split into batches and execute concurrently
	batches := chunksOf(allRequests, f.batchSize)
	var wg sync.WaitGroup
	var batchErr error
	var completedReceipts int64
	totalReceipts := int64(len(txInfos))

	for batchIdx, batch := range batches {
		wg.Add(1)
		go func(idx int, requests []jsonRpcRequest) {
			defer wg.Done()

			f.rpcLimit <- struct{}{}
			responses, err := f.batchRpcCall(requests)
			<-f.rpcLimit

			if err != nil {
				mu.Lock()
				if batchErr == nil {
					batchErr = fmt.Errorf("receipt batch %d failed: %w", idx, err)
				}
				mu.Unlock()
				return
			}

			// Store raw receipt responses
			for _, resp := range responses {
				txHash := txHashToIdx[resp.ID]

				mu.Lock()
				receiptsMap[txHash] = resp.Result
				mu.Unlock()
			}

			// Report progress
			mu.Lock()
			completedReceipts += int64(len(responses))
			if f.progressCb != nil {
				f.progressCb("receipts", completedReceipts, totalReceipts, len(responses))
			}
			mu.Unlock()
		}(batchIdx, batch)
	}

	wg.Wait()

	if batchErr != nil {
		return nil, batchErr
	}

	return receiptsMap, nil
}

func (f *Fetcher) fetchTracesBatch(from, to int64, txInfos []txInfo) (map[string]*TraceResultOptional, error) {
	tracesMap := make(map[string]*TraceResultOptional)
	var mu sync.Mutex

	// First try block-level tracing

	numBlocks := int(to - from + 1)
	var blockRequests []jsonRpcRequest

	for i := 0; i < numBlocks; i++ {
		blockNum := from + int64(i)
		blockRequests = append(blockRequests, jsonRpcRequest{
			Jsonrpc: "2.0",
			Method:  "debug_traceBlockByNumber",
			Params:  []interface{}{fmt.Sprintf("0x%x", blockNum), map[string]string{"tracer": "callTracer"}},
			ID:      i,
		})
	}

	// Try block traces in batches
	blockBatches := chunksOf(blockRequests, f.debugBatchSize)
	var blockTraceSuccess = true
	blockTraces := make(map[int64][]TraceResultOptional)

	var wg sync.WaitGroup
	var blockErr error

	for batchIdx, batch := range blockBatches {
		wg.Add(1)
		go func(idx int, requests []jsonRpcRequest) {
			defer wg.Done()

			f.debugLimit <- struct{}{}
			responses, err := f.batchRpcCallDebug(requests)
			<-f.debugLimit

			if err != nil {
				mu.Lock()
				blockTraceSuccess = false
				if blockErr == nil {
					blockErr = fmt.Errorf("debug batch %d failed: %w", idx, err)
				}
				mu.Unlock()
				return
			}

			// Parse block trace responses
			for _, resp := range responses {
				if resp.Error != nil {
					mu.Lock()
					blockTraceSuccess = false
					mu.Unlock()
					return
				}

				var traces []TraceResultOptional
				decoder := json.NewDecoder(bytes.NewReader(resp.Result))
				decoder.DisallowUnknownFields()
				if err := decoder.Decode(&traces); err != nil {
					mu.Lock()
					blockTraceSuccess = false
					mu.Unlock()
					return
				}

				blockNum := from + int64(resp.ID)
				mu.Lock()
				blockTraces[blockNum] = traces
				mu.Unlock()
			}
		}(batchIdx, batch)
	}

	wg.Wait()

	if blockTraceSuccess && blockErr == nil {
		// Map block traces to transaction hashes
		for _, txInfo := range txInfos {
			if traces, ok := blockTraces[txInfo.blockNum]; ok && txInfo.txIdx < len(traces) {
				tracesMap[txInfo.hash] = &traces[txInfo.txIdx]
			}
		}
		return tracesMap, nil
	}

	// Fall back to per-transaction tracing

	var txRequests []jsonRpcRequest
	txHashToIdx := make(map[int]string)

	for i, tx := range txInfos {
		txRequests = append(txRequests, jsonRpcRequest{
			Jsonrpc: "2.0",
			Method:  "debug_traceTransaction",
			Params:  []interface{}{tx.hash, map[string]string{"tracer": "callTracer"}},
			ID:      i,
		})
		txHashToIdx[i] = tx.hash
	}

	// Execute transaction traces in batches
	txBatches := chunksOf(txRequests, f.debugBatchSize)
	wg = sync.WaitGroup{}

	for batchIdx, batch := range txBatches {
		wg.Add(1)
		go func(idx int, requests []jsonRpcRequest) {
			defer wg.Done()

			f.debugLimit <- struct{}{}
			responses, err := f.batchRpcCallDebug(requests)
			<-f.debugLimit

			if err != nil {
				// For transaction traces, we continue even on errors
				fmt.Printf("Transaction trace batch %d failed: %v\n", idx, err)
				return
			}

			// Parse transaction trace responses
			for _, resp := range responses {
				txHash := txHashToIdx[resp.ID]

				if resp.Error != nil {
					// Check for precompile error
					if isPrecompileError(fmt.Errorf("%s", resp.Error.Message)) {
						fmt.Printf("Trace failed for tx %s (precompile), treating as nil trace\n", txHash)
					} else {
						fmt.Printf("Trace failed for tx %s: %v\n", txHash, resp.Error.Message)
					}

					mu.Lock()
					tracesMap[txHash] = &TraceResultOptional{
						TxHash: txHash,
						Result: nil,
					}
					mu.Unlock()
					continue
				}

				var trace CallTrace
				decoder := json.NewDecoder(bytes.NewReader(resp.Result))
				decoder.DisallowUnknownFields()
				if err := decoder.Decode(&trace); err != nil {
					fmt.Printf("Failed to parse trace for tx %s: %v\n", txHash, err)
					mu.Lock()
					tracesMap[txHash] = &TraceResultOptional{
						TxHash: txHash,
						Result: nil,
					}
					mu.Unlock()
					continue
				}

				mu.Lock()
				tracesMap[txHash] = &TraceResultOptional{
					TxHash: txHash,
					Result: &trace,
				}
				mu.Unlock()
			}
		}(batchIdx, batch)
	}

	wg.Wait()

	return tracesMap, nil
}

func isPrecompileError(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "incorrect number of top-level calls")
}
