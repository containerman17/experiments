package rpc

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

type Fetcher struct {
	controller     *Controller
	batchSize      int
	debugBatchSize int
	maxRetries     int
	retryDelay     time.Duration
	httpClient     *http.Client
	chainID        uint64
	chainName      string
}

type FetcherConfig struct {
	Controller *Controller
	ChainID    uint64
	ChainName  string
}

func NewFetcher(cfg FetcherConfig) *Fetcher {
	// Derive batch sizes from controller's parallelism
	parallelism := cfg.Controller.CurrentParallelism()
	batchSize := 100                         // Standard batch for blocks/receipts
	debugBatchSize := max(1, parallelism/10) // Debug calls are heavy, scale with parallelism
	if debugBatchSize > 20 {
		debugBatchSize = 20 // Cap at 20 to avoid overwhelming debug endpoint
	}

	transport := &http.Transport{
		MaxIdleConns:        10000,
		MaxIdleConnsPerHost: 10000,
		IdleConnTimeout:     90 * time.Second,
		DisableKeepAlives:   false,
		DialContext: (&net.Dialer{
			Timeout:   30 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
	}

	return &Fetcher{
		controller:     cfg.Controller,
		batchSize:      batchSize,
		debugBatchSize: debugBatchSize,
		maxRetries:     3,
		retryDelay:     500 * time.Millisecond,
		chainID:        cfg.ChainID,
		chainName:      cfg.ChainName,
		httpClient: &http.Client{
			Timeout:   5 * time.Minute,
			Transport: transport,
		},
	}
}

// Controller returns the underlying RPC controller
func (f *Fetcher) Controller() *Controller {
	return f.controller
}

// txInfo holds information about a transaction and its location
type txInfo struct {
	hash     string
	blockNum uint64
	blockIdx int
	txIdx    int
}

func (f *Fetcher) batchRpcCall(ctx context.Context, requests []JSONRPCRequest) ([]JSONRPCResponse, error) {
	if len(requests) == 0 {
		return []JSONRPCResponse{}, nil
	}

	jsonData, err := json.Marshal(requests)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal batch request: %w", err)
	}

	var responses []JSONRPCResponse
	var lastErr error

	for attempt := 0; attempt <= f.maxRetries; attempt++ {
		if attempt > 0 {
			delay := f.retryDelay * time.Duration(1<<uint(attempt-1))
			if delay > 10*time.Second {
				delay = 10 * time.Second
			}
			log.Printf("[Chain %d - %s] Batch request failed: %v. Retrying (%d/%d) after %v",
				f.chainID, f.chainName, lastErr, attempt, f.maxRetries, delay)
			time.Sleep(delay)
		}

		req, err := http.NewRequestWithContext(ctx, "POST", f.controller.URL(), bytes.NewBuffer(jsonData))
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
		err = decoder.Decode(&responses)
		resp.Body.Close()

		if err != nil {
			lastErr = fmt.Errorf("failed to unmarshal batch response: %w", err)
			continue
		}

		if len(responses) != len(requests) {
			lastErr = fmt.Errorf("batch response count mismatch: sent %d, got %d", len(requests), len(responses))
			continue
		}

		sort.Slice(responses, func(i, j int) bool {
			return responses[i].ID < responses[j].ID
		})

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

func (f *Fetcher) batchRpcCallDebug(ctx context.Context, requests []JSONRPCRequest) ([]JSONRPCResponse, error) {
	if len(requests) == 0 {
		return []JSONRPCResponse{}, nil
	}

	jsonData, err := json.Marshal(requests)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal debug batch request: %w", err)
	}

	var responses []JSONRPCResponse
	var lastErr error

	for attempt := 0; attempt <= f.maxRetries; attempt++ {
		if attempt > 0 {
			delay := f.retryDelay * time.Duration(1<<uint(attempt-1))
			if delay > 10*time.Second {
				delay = 10 * time.Second
			}
			log.Printf("[Chain %d - %s] Debug batch request failed: %v. Retrying (%d/%d) after %v",
				f.chainID, f.chainName, lastErr, attempt, f.maxRetries, delay)
			time.Sleep(delay)
		}

		req, err := http.NewRequestWithContext(ctx, "POST", f.controller.URL(), bytes.NewBuffer(jsonData))
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
		err = decoder.Decode(&responses)
		resp.Body.Close()

		if err != nil {
			lastErr = fmt.Errorf("failed to unmarshal debug batch response: %w", err)
			continue
		}

		sort.Slice(responses, func(i, j int) bool {
			return responses[i].ID < responses[j].ID
		})

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

func (f *Fetcher) GetLatestBlock(ctx context.Context) (uint64, error) {
	requests := []JSONRPCRequest{{
		Jsonrpc: "2.0",
		Method:  "eth_blockNumber",
		Params:  []interface{}{},
		ID:      1,
	}}

	var responses []JSONRPCResponse
	err := f.controller.Execute(ctx, func() error {
		var err error
		responses, err = f.batchRpcCall(ctx, requests)
		return err
	})
	if err != nil {
		return 0, err
	}

	var blockNumHex string
	if err := json.Unmarshal(responses[0].Result, &blockNumHex); err != nil {
		return 0, fmt.Errorf("failed to unmarshal block number: %w", err)
	}

	var blockNum uint64
	if _, err := fmt.Sscanf(blockNumHex, "0x%x", &blockNum); err != nil {
		return 0, fmt.Errorf("failed to parse block number: %w", err)
	}

	return blockNum, nil
}

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

// FetchBlockRange fetches all blocks in [from, to] inclusive with receipts and traces
func (f *Fetcher) FetchBlockRange(ctx context.Context, from, to uint64) ([]*NormalizedBlock, error) {
	if from > to {
		return nil, fmt.Errorf("invalid range: from %d > to %d", from, to)
	}

	// Fetch blocks
	blocks, err := f.fetchBlocksBatch(ctx, from, to)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch blocks: %w", err)
	}

	// Collect all transactions
	var allTxs []txInfo
	for blockIdx, block := range blocks {
		blockNum := from + uint64(blockIdx)
		for txIdx, tx := range block.Transactions {
			allTxs = append(allTxs, txInfo{
				hash:     tx.Hash,
				blockNum: blockNum,
				blockIdx: blockIdx,
				txIdx:    txIdx,
			})
		}
	}

	// Fetch receipts
	var receiptsMap map[string]Receipt
	if len(allTxs) > 0 {
		receiptsMap, err = f.fetchReceiptsBatch(ctx, allTxs)
		if err != nil {
			return nil, fmt.Errorf("failed to fetch receipts: %w", err)
		}
	} else {
		receiptsMap = make(map[string]Receipt)
	}

	// Fetch traces
	var tracesMap map[string]*TraceResultOptional
	if len(allTxs) > 0 {
		tracesMap, err = f.fetchTracesBatch(ctx, from, to, allTxs)
		if err != nil {
			return nil, fmt.Errorf("failed to fetch traces: %w", err)
		}
	} else {
		tracesMap = make(map[string]*TraceResultOptional)
	}

	// Assemble normalized blocks
	result := make([]*NormalizedBlock, len(blocks))
	for i := range blocks {
		blockNum := from + uint64(i)
		receipts := make([]Receipt, len(blocks[i].Transactions))
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
				traces[j] = TraceResultOptional{TxHash: tx.Hash, Result: nil}
			}
		}

		result[i] = &NormalizedBlock{
			Block:    blocks[i],
			Receipts: receipts,
			Traces:   traces,
		}
	}

	return result, nil
}

func (f *Fetcher) fetchBlocksBatch(ctx context.Context, from, to uint64) ([]Block, error) {
	numBlocks := int(to - from + 1)
	blocks := make([]Block, numBlocks)

	var allRequests []JSONRPCRequest
	for i := uint64(0); i < uint64(numBlocks); i++ {
		blockNum := from + i
		allRequests = append(allRequests, JSONRPCRequest{
			Jsonrpc: "2.0",
			Method:  "eth_getBlockByNumber",
			Params:  []interface{}{fmt.Sprintf("0x%x", blockNum), true},
			ID:      int(i),
		})
	}

	batches := chunksOf(allRequests, f.batchSize)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var batchErr error

	for batchIdx, batch := range batches {
		wg.Add(1)
		go func(idx int, requests []JSONRPCRequest) {
			defer wg.Done()

			var responses []JSONRPCResponse
			err := f.controller.Execute(ctx, func() error {
				var err error
				responses, err = f.batchRpcCall(ctx, requests)
				return err
			})

			if err != nil {
				mu.Lock()
				if batchErr == nil {
					batchErr = fmt.Errorf("batch %d failed: %w", idx, err)
				}
				mu.Unlock()
				return
			}

			for _, resp := range responses {
				var block Block
				if err := StrictUnmarshal(resp.Result, &block); err != nil {
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

func (f *Fetcher) fetchReceiptsBatch(ctx context.Context, txInfos []txInfo) (map[string]Receipt, error) {
	receiptsMap := make(map[string]Receipt)
	var mu sync.Mutex

	var allRequests []JSONRPCRequest
	txHashToIdx := make(map[int]string)

	for i, tx := range txInfos {
		allRequests = append(allRequests, JSONRPCRequest{
			Jsonrpc: "2.0",
			Method:  "eth_getTransactionReceipt",
			Params:  []interface{}{tx.hash},
			ID:      i,
		})
		txHashToIdx[i] = tx.hash
	}

	batches := chunksOf(allRequests, f.batchSize)
	var wg sync.WaitGroup
	var batchErr error

	for batchIdx, batch := range batches {
		wg.Add(1)
		go func(idx int, requests []JSONRPCRequest) {
			defer wg.Done()

			var responses []JSONRPCResponse
			err := f.controller.Execute(ctx, func() error {
				var err error
				responses, err = f.batchRpcCall(ctx, requests)
				return err
			})

			if err != nil {
				mu.Lock()
				if batchErr == nil {
					batchErr = fmt.Errorf("receipt batch %d failed: %w", idx, err)
				}
				mu.Unlock()
				return
			}

			for _, resp := range responses {
				txHash := txHashToIdx[resp.ID]
				var receipt Receipt
				if err := StrictUnmarshal(resp.Result, &receipt); err != nil {
					mu.Lock()
					if batchErr == nil {
						batchErr = fmt.Errorf("failed to unmarshal receipt for tx %s: %w", txHash, err)
					}
					mu.Unlock()
					return
				}
				mu.Lock()
				receiptsMap[txHash] = receipt
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

func (f *Fetcher) fetchTracesBatch(ctx context.Context, from, to uint64, txInfos []txInfo) (map[string]*TraceResultOptional, error) {
	tracesMap := make(map[string]*TraceResultOptional)
	var mu sync.Mutex

	// Try block-level tracing first
	numBlocks := int(to - from + 1)
	var blockRequests []JSONRPCRequest
	for i := 0; i < numBlocks; i++ {
		blockNum := from + uint64(i)
		blockRequests = append(blockRequests, JSONRPCRequest{
			Jsonrpc: "2.0",
			Method:  "debug_traceBlockByNumber",
			Params:  []interface{}{fmt.Sprintf("0x%x", blockNum), map[string]string{"tracer": "callTracer"}},
			ID:      i,
		})
	}

	blockBatches := chunksOf(blockRequests, f.debugBatchSize)
	blockTraceSuccess := true
	blockTraces := make(map[uint64][]TraceResultOptional)

	var wg sync.WaitGroup
	var blockErr error

	for batchIdx, batch := range blockBatches {
		wg.Add(1)
		go func(idx int, requests []JSONRPCRequest) {
			defer wg.Done()

			var responses []JSONRPCResponse
			err := f.controller.Execute(ctx, func() error {
				var err error
				responses, err = f.batchRpcCallDebug(ctx, requests)
				return err
			})

			if err != nil {
				mu.Lock()
				blockTraceSuccess = false
				if blockErr == nil {
					blockErr = fmt.Errorf("debug batch %d failed: %w", idx, err)
				}
				mu.Unlock()
				return
			}

			for _, resp := range responses {
				if resp.Error != nil {
					mu.Lock()
					blockTraceSuccess = false
					mu.Unlock()
					return
				}

				var traces []TraceResultOptional
				if err := StrictUnmarshal(resp.Result, &traces); err != nil {
					mu.Lock()
					blockTraceSuccess = false
					mu.Unlock()
					return
				}

				blockNum := from + uint64(resp.ID)
				mu.Lock()
				blockTraces[blockNum] = traces
				mu.Unlock()
			}
		}(batchIdx, batch)
	}

	wg.Wait()

	if blockTraceSuccess && blockErr == nil {
		for _, txInfo := range txInfos {
			if traces, ok := blockTraces[txInfo.blockNum]; ok && txInfo.txIdx < len(traces) {
				tracesMap[txInfo.hash] = &traces[txInfo.txIdx]
			}
		}
		return tracesMap, nil
	}

	// Fallback to per-transaction tracing
	var txRequests []JSONRPCRequest
	txHashToIdx := make(map[int]string)

	for i, tx := range txInfos {
		txRequests = append(txRequests, JSONRPCRequest{
			Jsonrpc: "2.0",
			Method:  "debug_traceTransaction",
			Params:  []interface{}{tx.hash, map[string]string{"tracer": "callTracer"}},
			ID:      i,
		})
		txHashToIdx[i] = tx.hash
	}

	txBatches := chunksOf(txRequests, f.debugBatchSize)
	wg = sync.WaitGroup{}
	var txBatchErr error

	for batchIdx, batch := range txBatches {
		wg.Add(1)
		go func(idx int, requests []JSONRPCRequest) {
			defer wg.Done()

			var responses []JSONRPCResponse
			var err error

			for attempt := 0; attempt <= f.maxRetries; attempt++ {
				if attempt > 0 {
					delay := f.retryDelay * time.Duration(1<<uint(attempt-1))
					if delay > 10*time.Second {
						delay = 10 * time.Second
					}
					time.Sleep(delay)
				}

				err = f.controller.Execute(ctx, func() error {
					var innerErr error
					responses, innerErr = f.batchRpcCallDebug(ctx, requests)
					return innerErr
				})

				if err != nil {
					continue
				}

				hasRetryableError := false
				for _, resp := range responses {
					if resp.Error != nil && !isPrecompileError(resp.Error.Message) {
						hasRetryableError = true
						break
					}
				}

				if !hasRetryableError {
					break
				}
			}

			if err != nil {
				mu.Lock()
				if txBatchErr == nil {
					txBatchErr = fmt.Errorf("trace batch %d failed after retries: %w", idx, err)
				}
				mu.Unlock()
				return
			}

			for _, resp := range responses {
				txHash := txHashToIdx[resp.ID]

				if resp.Error != nil {
					if isPrecompileError(resp.Error.Message) {
						mu.Lock()
						tracesMap[txHash] = &TraceResultOptional{TxHash: txHash, Result: nil}
						mu.Unlock()
						continue
					} else {
						mu.Lock()
						if txBatchErr == nil {
							txBatchErr = fmt.Errorf("trace for tx %s failed: %s", txHash, resp.Error.Message)
						}
						mu.Unlock()
						return
					}
				}

				var trace CallTrace
				if err := StrictUnmarshal(resp.Result, &trace); err != nil {
					mu.Lock()
					if txBatchErr == nil {
						txBatchErr = fmt.Errorf("failed to parse trace for tx %s: %w", txHash, err)
					}
					mu.Unlock()
					return
				}

				mu.Lock()
				tracesMap[txHash] = &TraceResultOptional{TxHash: txHash, Result: &trace}
				mu.Unlock()
			}
		}(batchIdx, batch)
	}

	wg.Wait()
	if txBatchErr != nil {
		return nil, txBatchErr
	}
	return tracesMap, nil
}

func isPrecompileError(msg string) bool {
	return strings.Contains(msg, "incorrect number of top-level calls")
}
