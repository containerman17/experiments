package rpc

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

type Transaction struct {
	Hash                 string          `json:"hash"`
	Nonce                json.RawMessage `json:"nonce"`
	BlockHash            string          `json:"blockHash"`
	BlockNumber          json.RawMessage `json:"blockNumber"`
	TransactionIndex     json.RawMessage `json:"transactionIndex"`
	From                 string          `json:"from"`
	To                   string          `json:"to"`
	Value                json.RawMessage `json:"value"`
	Gas                  json.RawMessage `json:"gas"`
	GasPrice             json.RawMessage `json:"gasPrice"`
	Input                string          `json:"input"`
	V                    json.RawMessage `json:"v,omitempty"`
	R                    json.RawMessage `json:"r,omitempty"`
	S                    json.RawMessage `json:"s,omitempty"`
	YParity              json.RawMessage `json:"yParity,omitempty"`
	Type                 json.RawMessage `json:"type,omitempty"`
	TypeHex              json.RawMessage `json:"typeHex,omitempty"`
	ChainId              json.RawMessage `json:"chainId,omitempty"`
	MaxFeePerGas         json.RawMessage `json:"maxFeePerGas,omitempty"`
	MaxPriorityFeePerGas json.RawMessage `json:"maxPriorityFeePerGas,omitempty"`
	AccessList           json.RawMessage `json:"accessList,omitempty"`
}

type Block struct {
	Number                json.RawMessage `json:"number"`
	Hash                  string          `json:"hash"`
	ParentHash            string          `json:"parentHash"`
	Timestamp             json.RawMessage `json:"timestamp"`
	Miner                 string          `json:"miner"`
	Difficulty            json.RawMessage `json:"difficulty"`
	TotalDifficulty       json.RawMessage `json:"totalDifficulty"`
	Size                  json.RawMessage `json:"size"`
	GasLimit              json.RawMessage `json:"gasLimit"`
	GasUsed               json.RawMessage `json:"gasUsed"`
	BaseFeePerGas         json.RawMessage `json:"baseFeePerGas,omitempty"`
	BlockGasCost          json.RawMessage `json:"blockGasCost,omitempty"`
	Transactions          []Transaction   `json:"transactions"`
	StateRoot             string          `json:"stateRoot"`
	TransactionsRoot      string          `json:"transactionsRoot"`
	ReceiptsRoot          string          `json:"receiptsRoot"`
	ExtraData             string          `json:"extraData,omitempty"`
	BlockExtraData        string          `json:"blockExtraData,omitempty"`
	ExtDataHash           string          `json:"extDataHash,omitempty"`
	ExtDataGasUsed        json.RawMessage `json:"extDataGasUsed,omitempty"`
	LogsBloom             string          `json:"logsBloom"`
	MixHash               string          `json:"mixHash"`
	Nonce                 string          `json:"nonce"`
	Sha3Uncles            string          `json:"sha3Uncles"`
	Uncles                json.RawMessage `json:"uncles,omitempty"`
	BlobGasUsed           json.RawMessage `json:"blobGasUsed,omitempty"`
	ExcessBlobGas         json.RawMessage `json:"excessBlobGas,omitempty"`
	ParentBeaconBlockRoot string          `json:"parentBeaconBlockRoot,omitempty"`
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

type FetcherOptions struct {
	RpcURL           string
	RpcConcurrency   int // Number of concurrent batch requests
	DebugConcurrency int // Number of concurrent debug batch requests
	BatchSize        int // Number of requests per batch
	DebugBatchSize   int // Number of debug requests per batch
}

type Fetcher struct {
	rpcURL         string
	batchSize      int
	debugBatchSize int

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

	return &Fetcher{
		rpcURL:         opts.RpcURL,
		batchSize:      opts.BatchSize,
		debugBatchSize: opts.DebugBatchSize,
		rpcLimit:       make(chan struct{}, opts.RpcConcurrency),
		debugLimit:     make(chan struct{}, opts.DebugConcurrency),
		httpClient: &http.Client{
			Timeout: 5 * time.Minute,
		},
	}
}

// batchRpcCall sends a batch of JSON-RPC requests
func (f *Fetcher) batchRpcCall(requests []jsonRpcRequest) ([]jsonRpcResponse, error) {
	if len(requests) == 0 {
		return []jsonRpcResponse{}, nil
	}

	jsonData, err := json.Marshal(requests)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal batch request: %w", err)
	}

	req, err := http.NewRequest("POST", f.rpcURL, bytes.NewBuffer(jsonData))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")

	resp, err := f.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to make batch request: %w", err)
	}
	defer resp.Body.Close()

	var responses []jsonRpcResponse
	decoder := json.NewDecoder(resp.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&responses); err != nil {
		return nil, fmt.Errorf("failed to unmarshal batch response: %w", err)
	}

	// Validate responses
	if len(responses) != len(requests) {
		return nil, fmt.Errorf("batch response count mismatch: sent %d, got %d", len(requests), len(responses))
	}

	// Sort responses by ID to match request order
	sort.Slice(responses, func(i, j int) bool {
		return responses[i].ID < responses[j].ID
	})

	// Validate all responses and check for errors
	for i, resp := range responses {
		if resp.ID != requests[i].ID {
			return nil, fmt.Errorf("batch response ID mismatch at index %d: expected %d, got %d", i, requests[i].ID, resp.ID)
		}
		if resp.Error != nil {
			return nil, fmt.Errorf("RPC error in batch at index %d (ID %d): %s", i, resp.ID, resp.Error.Message)
		}
		if len(resp.Result) == 0 {
			return nil, fmt.Errorf("empty result in batch response at index %d (ID %d)", i, resp.ID)
		}
	}

	return responses, nil
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

	req, err := http.NewRequest("POST", f.rpcURL, bytes.NewBuffer(jsonData))
	if err != nil {
		return nil, fmt.Errorf("failed to create debug request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")

	resp, err := f.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to make debug batch request: %w", err)
	}
	defer resp.Body.Close()

	var responses []jsonRpcResponse
	decoder := json.NewDecoder(resp.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&responses); err != nil {
		return nil, fmt.Errorf("failed to unmarshal debug batch response: %w", err)
	}

	// Sort responses by ID to match request order
	sort.Slice(responses, func(i, j int) bool {
		return responses[i].ID < responses[j].ID
	})

	// For debug calls, we allow some errors (like precompile errors) but still validate structure
	if len(responses) != len(requests) {
		return nil, fmt.Errorf("debug batch response count mismatch: sent %d, got %d", len(requests), len(responses))
	}

	for i, resp := range responses {
		if resp.ID != requests[i].ID {
			return nil, fmt.Errorf("debug batch response ID mismatch at index %d: expected %d, got %d", i, requests[i].ID, resp.ID)
		}
	}

	return responses, nil
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

	numBlocks := int(to - from + 1)
	fmt.Printf("Fetching %d blocks from %d to %d\n", numBlocks, from, to)

	// Phase 1: Batch fetch all blocks
	fmt.Printf("Phase 1: Fetching blocks in batches of %d...\n", f.batchSize)
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

	fmt.Printf("Found %d total transactions across all blocks\n", len(allTxs))

	// Phase 2: Batch fetch all receipts
	var receiptsMap map[string]json.RawMessage
	if len(allTxs) > 0 {
		fmt.Printf("Phase 2: Fetching %d receipts in batches of %d...\n", len(allTxs), f.batchSize)
		receiptsMap, err = f.fetchReceiptsBatch(allTxs)
		if err != nil {
			return nil, fmt.Errorf("failed to fetch receipts: %w", err)
		}
	} else {
		receiptsMap = make(map[string]json.RawMessage)
	}

	// Phase 3: Batch fetch all traces
	var tracesMap map[string]*TraceResultOptional
	if len(allTxs) > 0 {
		fmt.Printf("Phase 3: Fetching traces in batches of %d...\n", f.debugBatchSize)
		tracesMap, err = f.fetchTracesBatch(from, to, allTxs)
		if err != nil {
			return nil, fmt.Errorf("failed to fetch traces: %w", err)
		}
	} else {
		tracesMap = make(map[string]*TraceResultOptional)
	}

	// Assemble normalized blocks
	result := make([]*NormalizedBlock, numBlocks)
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

	fmt.Printf("Successfully fetched %d blocks with all receipts and traces\n", numBlocks)
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

				mu.Lock()
				blocks[resp.ID] = block
				mu.Unlock()
			}
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
	fmt.Printf("Attempting block-level tracing for blocks %d to %d\n", from, to)

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
		fmt.Printf("Successfully used block-level tracing\n")
		return tracesMap, nil
	}

	// Fall back to per-transaction tracing
	fmt.Printf("Block-level tracing failed, falling back to per-transaction tracing\n")

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
