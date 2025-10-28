package archiver

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Block struct {
	Number                json.RawMessage   `json:"number"`
	Hash                  string            `json:"hash"`
	ParentHash            string            `json:"parentHash"`
	Timestamp             json.RawMessage   `json:"timestamp"`
	Miner                 string            `json:"miner"`
	Difficulty            json.RawMessage   `json:"difficulty"`
	TotalDifficulty       json.RawMessage   `json:"totalDifficulty"`
	Size                  json.RawMessage   `json:"size"`
	GasLimit              json.RawMessage   `json:"gasLimit"`
	GasUsed               json.RawMessage   `json:"gasUsed"`
	BaseFeePerGas         json.RawMessage   `json:"baseFeePerGas,omitempty"`
	Transactions          []json.RawMessage `json:"transactions"`
	StateRoot             string            `json:"stateRoot"`
	TransactionsRoot      string            `json:"transactionsRoot"`
	ReceiptsRoot          string            `json:"receiptsRoot"`
	ExtraData             string            `json:"extraData,omitempty"`
	BlockExtraData        string            `json:"blockExtraData,omitempty"`
	ExtDataHash           string            `json:"extDataHash,omitempty"`
	LogsBloom             string            `json:"logsBloom"`
	MixHash               string            `json:"mixHash"`
	Nonce                 string            `json:"nonce"`
	Sha3Uncles            string            `json:"sha3Uncles"`
	Uncles                json.RawMessage   `json:"uncles,omitempty"`
	BlobGasUsed           json.RawMessage   `json:"blobGasUsed,omitempty"`
	ExcessBlobGas         json.RawMessage   `json:"excessBlobGas,omitempty"`
	ParentBeaconBlockRoot string            `json:"parentBeaconBlockRoot,omitempty"`
	WithdrawalsRoot       string            `json:"withdrawalsRoot,omitempty"`
	Withdrawals           json.RawMessage   `json:"withdrawals,omitempty"`
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

	// Live mode support (for recent blocks from writer)
	liveBuffer     []*NormalizedBlock
	liveBufferSize int
	firstLiveBlock int64
	lastLiveBlock  int64
	liveBufferIdx  int  // Current write position in circular buffer
	liveMode       bool // true = reading from live buffer, false = reading from archives
}

func NewBatchReader(rootDir string, startFromBlock int64, batchSize int) *BatchReader {
	// Calculate the file start for the starting block
	var fileStart int64
	if startFromBlock <= 999 {
		fileStart = 1
	} else {
		fileStart = (startFromBlock / 1000) * 1000
	}

	liveBufferSize := 3000
	return &BatchReader{
		rootDir:        rootDir,
		nextBlock:      startFromBlock,
		batchSize:      batchSize,
		blockBuffer:    nil,
		bufferIndex:    0,
		nextFileStart:  fileStart,
		liveBuffer:     make([]*NormalizedBlock, liveBufferSize),
		liveBufferSize: liveBufferSize,
		firstLiveBlock: -1,
		lastLiveBlock:  -1,
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
	if err := json.Unmarshal(block.Block.Number, &blockNum); err != nil {
		var blockNumStr string
		if err := json.Unmarshal(block.Block.Number, &blockNumStr); err != nil {
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

	// Collect all blocks
	var allBlocks []*NormalizedBlock
	for i, res := range results {
		if res.err != nil {
			return fmt.Errorf("error parsing file %s: %w", filesToLoad[i], res.err)
		}
		allBlocks = append(allBlocks, res.blocks...)
	}

	// Sort blocks by block number
	sort.Slice(allBlocks, func(i, j int) bool {
		numI, _ := getBlockNumber(allBlocks[i])
		numJ, _ := getBlockNumber(allBlocks[j])
		return numI < numJ
	})

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
	// If in live mode, check if archive file has appeared
	if br.liveMode {
		// Check if an archive file exists for this block (writer may have created it)
		if _, err := br.findFileForBlock(br.nextBlock); err == nil {
			// Archive file exists now, switch back to archive mode
			fmt.Printf("BatchReader: Archive file appeared, switching back to archive mode at block %d\n", br.nextBlock)
			br.liveMode = false
			br.blockBuffer = nil // Clear buffer to force reload
			br.bufferIndex = 0
			return br.NextBlock()
		}

		// Wait for block to appear in live buffer
		for {
			if block := br.getBlockFromLiveBuffer(br.nextBlock); block != nil {
				br.nextBlock++
				return block, nil
			}
			// Wait for block to appear in buffer
			time.Sleep(10 * time.Millisecond)
		}
	}

	// Archive mode: Load new batch if buffer is empty or exhausted
	if br.blockBuffer == nil || br.bufferIndex >= len(br.blockBuffer) {
		if err := br.loadBatch(); err != nil {
			// No more archive files, switch to live mode
			fmt.Printf("BatchReader: Switching to live mode at block %d\n", br.nextBlock)
			br.liveMode = true
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

// FeedBlock adds a block to the circular live buffer (for writer to use)
func (br *BatchReader) FeedBlock(block *NormalizedBlock) {
	// Parse block number
	blockNum, err := getBlockNumber(block)
	if err != nil {
		return
	}

	// Initialize buffer range on first block
	if br.firstLiveBlock == -1 {
		br.firstLiveBlock = blockNum
		br.lastLiveBlock = blockNum
		br.liveBuffer[0] = block
		br.liveBufferIdx = 1
		return
	}

	// Add to circular buffer
	br.liveBuffer[br.liveBufferIdx] = block
	br.liveBufferIdx = (br.liveBufferIdx + 1) % br.liveBufferSize

	// Update range
	if blockNum > br.lastLiveBlock {
		br.lastLiveBlock = blockNum
	}

	// If buffer is full, advance firstLiveBlock
	if br.lastLiveBlock-br.firstLiveBlock >= int64(br.liveBufferSize) {
		br.firstLiveBlock = br.lastLiveBlock - int64(br.liveBufferSize) + 1
	}
}

// getBlockFromLiveBuffer returns a block from live buffer if available
func (br *BatchReader) getBlockFromLiveBuffer(blockNum int64) *NormalizedBlock {
	if br.firstLiveBlock == -1 || blockNum < br.firstLiveBlock || blockNum > br.lastLiveBlock {
		return nil
	}

	// Calculate position in circular buffer
	offset := blockNum - br.firstLiveBlock
	index := int(offset) % br.liveBufferSize

	// Verify this is the right block
	block := br.liveBuffer[index]
	if block != nil {
		actualNum, _ := getBlockNumber(block)
		if actualNum == blockNum {
			return block
		}
	}

	return nil
}
