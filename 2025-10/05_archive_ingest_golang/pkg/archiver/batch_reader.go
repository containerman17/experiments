package archiver

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
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
	Value        string      `json:"value"`
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

type BatchReader struct {
	rootDir       string
	nextBlock     int64
	batchSize     int
	blockBuffer   []*NormalizedBlock
	bufferIndex   int
	nextFileStart int64 // Track which file to load next
}

func NewBatchReader(rootDir string, startFromBlock int64, batchSize int) *BatchReader {
	// Calculate the file start for the starting block
	var fileStart int64
	if startFromBlock <= 999 {
		fileStart = 1
	} else {
		fileStart = (startFromBlock / 1000) * 1000
	}

	return &BatchReader{
		rootDir:       rootDir,
		nextBlock:     startFromBlock,
		batchSize:     batchSize,
		blockBuffer:   nil,
		bufferIndex:   0,
		nextFileStart: fileStart,
	}
}

// findFileForBlock returns the path to the file containing the given block number
func (br *BatchReader) findFileForBlock(blockNum int64) (string, error) {
	var fileStart int64
	if blockNum <= 999 {
		fileStart = 1
	} else {
		fileStart = (blockNum / 1000) * 1000
	}

	millions := fileStart / 1000000
	thousands := (fileStart % 1000000) / 1000

	millionDir := fmt.Sprintf("%04d", millions)
	fileName := fmt.Sprintf("%03dxxx.jsonl.zstd", thousands)

	filePath := filepath.Join(br.rootDir, millionDir, fileName)

	if _, err := os.Stat(filePath); err != nil {
		return "", fmt.Errorf("file not found for block %d: %s", blockNum, filePath)
	}

	return filePath, nil
}

// parseFile decompresses and parses all blocks from a file
func (br *BatchReader) parseFile(filePath string) ([]*NormalizedBlock, error) {
	cmd := exec.Command("zstd", "-d", "-c", filePath)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("failed to create stdout pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to start zstd: %w", err)
	}

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 10*1024*1024), 10*1024*1024)

	var blocks []*NormalizedBlock

	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}

		var block NormalizedBlock
		decoder := json.NewDecoder(strings.NewReader(line))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&block); err != nil {
			cmd.Process.Kill()
			cmd.Wait()
			return nil, fmt.Errorf("failed to unmarshal block: %w", err)
		}

		blocks = append(blocks, &block)
	}

	if err := scanner.Err(); err != nil {
		cmd.Process.Kill()
		cmd.Wait()
		return nil, fmt.Errorf("scanner error: %w", err)
	}

	if err := cmd.Wait(); err != nil {
		return nil, fmt.Errorf("zstd process error: %w", err)
	}

	return blocks, nil
}

// getBlockNumber extracts block number from a NormalizedBlock
func getBlockNumber(block *NormalizedBlock) (int64, error) {
	var blockNum int64
	decoder := json.NewDecoder(strings.NewReader(string(block.Block.Number)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&blockNum); err != nil {
		var blockNumStr string
		decoder2 := json.NewDecoder(strings.NewReader(string(block.Block.Number)))
		decoder2.DisallowUnknownFields()
		if err := decoder2.Decode(&blockNumStr); err != nil {
			return 0, fmt.Errorf("failed to parse block number: %w", err)
		}
		var parseErr error
		blockNum, parseErr = strconv.ParseInt(blockNumStr, 0, 64)
		if parseErr != nil {
			return 0, fmt.Errorf("failed to parse block number string: %w", parseErr)
		}
	}
	return blockNum, nil
}

// loadBatch loads the next batch of files in parallel
func (br *BatchReader) loadBatch() error {
	var filesToLoad []string

	// Determine which files to load based on nextFileStart
	fileStart := br.nextFileStart
	for i := 0; i < br.batchSize; i++ {
		filePath, err := br.findFileForBlock(fileStart)
		if err != nil {
			// No more files available
			if i == 0 {
				return fmt.Errorf("no files available starting from block %d", fileStart)
			}
			break
		}
		filesToLoad = append(filesToLoad, filePath)

		// Next file: first file (1-999) is special, after that each file has 1000 blocks
		if fileStart == 1 {
			fileStart = 1000 // After first file, next starts at 1000
		} else {
			fileStart += 1000 // Subsequent files are at 1000 block intervals
		}
	}

	if len(filesToLoad) == 0 {
		return fmt.Errorf("no files to load")
	}

	// Parse files in parallel
	type result struct {
		blocks []*NormalizedBlock
		err    error
	}

	results := make([]result, len(filesToLoad))
	var wg sync.WaitGroup

	for i, filePath := range filesToLoad {
		wg.Add(1)
		go func(idx int, path string) {
			defer wg.Done()
			blocks, err := br.parseFile(path)
			results[idx] = result{blocks: blocks, err: err}
		}(i, filePath)
	}

	wg.Wait()

	// Collect all blocks (already in order since files are sorted)
	var allBlocks []*NormalizedBlock
	for i, res := range results {
		if res.err != nil {
			return fmt.Errorf("error parsing file %s: %w", filesToLoad[i], res.err)
		}
		allBlocks = append(allBlocks, res.blocks...)
	}

	// Filter out blocks before nextBlock (for the first batch or partial file reads)
	var filteredBlocks []*NormalizedBlock
	for _, block := range allBlocks {
		blockNum, err := getBlockNumber(block)
		if err != nil {
			return fmt.Errorf("error getting block number during filtering: %w", err)
		}
		if blockNum >= br.nextBlock {
			filteredBlocks = append(filteredBlocks, block)
		}
	}

	br.blockBuffer = filteredBlocks
	br.bufferIndex = 0

	// Update nextFileStart to the next file after this batch
	br.nextFileStart = fileStart

	return nil
}

// NextBlock returns the next block, loading a new batch if needed
func (br *BatchReader) NextBlock() (*NormalizedBlock, error) {
	// Load new batch if buffer is empty or exhausted
	if br.blockBuffer == nil || br.bufferIndex >= len(br.blockBuffer) {
		if err := br.loadBatch(); err != nil {
			// No files available, wait for writer to create them
			fmt.Printf("Waiting for file with block %d...\n", br.nextBlock)
			time.Sleep(5 * time.Second)
			return br.NextBlock()
		}
	}

	block := br.blockBuffer[br.bufferIndex]
	br.bufferIndex++

	// Update nextBlock for filtering in subsequent batches
	blockNum, err := getBlockNumber(block)
	if err != nil {
		return nil, err
	}
	br.nextBlock = blockNum + 1

	return block, nil
}

func (br *BatchReader) Close() {
	// Nothing to close in batch reader
}
