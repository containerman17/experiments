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
	"time"
)

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

type TraceResultOptional struct {
	TxHash string     `json:"txHash"`
	Result *CallTrace `json:"result"`
}

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

type NormalizedBlock struct {
	Block    Block                 `json:"block"`
	Traces   []TraceResultOptional `json:"traces"`
	Receipts json.RawMessage       `json:"receipts"`
}

type BlockReader struct {
	rootDir       string
	currentFile   *os.File
	currentReader *bufio.Scanner
	currentCmd    *exec.Cmd
	nextBlock     int64

	// Live buffer for recent blocks
	buffer      []*NormalizedBlock
	bufferSize  int
	firstBlock  int64
	lastBlock   int64
	bufferIndex int // Current write position in circular buffer

	// Mode tracking
	liveMode bool // true = reading from buffer, false = reading from archives
}

func NewBlockReader(rootDir string, startFromBlock int64) *BlockReader {
	bufferSize := 2000
	return &BlockReader{
		rootDir:    rootDir,
		nextBlock:  startFromBlock,
		buffer:     make([]*NormalizedBlock, bufferSize),
		bufferSize: bufferSize,
		firstBlock: -1,
		lastBlock:  -1,
	}
}

// FeedBlock adds a block to the circular buffer
func (r *BlockReader) FeedBlock(block *NormalizedBlock) {
	// Parse block number
	var blockNum int64
	if err := json.Unmarshal(block.Block.Number, &blockNum); err != nil {
		// Try string format
		var blockNumStr string
		if json.Unmarshal(block.Block.Number, &blockNumStr) == nil {
			blockNum, _ = strconv.ParseInt(blockNumStr, 0, 64)
		}
	}

	// Initialize buffer range on first block
	if r.firstBlock == -1 {
		r.firstBlock = blockNum
		r.lastBlock = blockNum
		r.buffer[0] = block
		r.bufferIndex = 1
		return
	}

	// Add to circular buffer
	r.buffer[r.bufferIndex] = block
	r.bufferIndex = (r.bufferIndex + 1) % r.bufferSize

	// Update range
	if blockNum > r.lastBlock {
		r.lastBlock = blockNum
	}

	// If buffer is full, advance firstBlock
	if r.lastBlock-r.firstBlock >= int64(r.bufferSize) {
		r.firstBlock = r.lastBlock - int64(r.bufferSize) + 1
	}
}

// getBlockFromBuffer returns a block from buffer if available
func (r *BlockReader) getBlockFromBuffer(blockNum int64) *NormalizedBlock {
	if r.firstBlock == -1 || blockNum < r.firstBlock || blockNum > r.lastBlock {
		return nil
	}

	// Calculate position in circular buffer
	offset := blockNum - r.firstBlock
	index := int(offset) % r.bufferSize

	// Verify this is the right block
	block := r.buffer[index]
	if block != nil {
		var actualNum int64
		if err := json.Unmarshal(block.Block.Number, &actualNum); err != nil {
			var blockNumStr string
			if json.Unmarshal(block.Block.Number, &blockNumStr) == nil {
				actualNum, _ = strconv.ParseInt(blockNumStr, 0, 64)
			}
		}
		if actualNum == blockNum {
			return block
		}
	}

	return nil
}

func (r *BlockReader) Close() {
	if r.currentReader != nil {
		// Scanner doesn't need explicit close
		r.currentReader = nil
	}
	if r.currentFile != nil {
		r.currentFile.Close()
		r.currentFile = nil
	}
	if r.currentCmd != nil {
		r.currentCmd.Process.Kill()
		r.currentCmd.Wait()
		r.currentCmd = nil
	}
}

// findFileForBlock returns the path to the file containing the given block number
func (r *BlockReader) findFileForBlock(blockNum int64) (string, error) {
	// Calculate which file should contain this block
	// Blocks 1-999: 0000/000xxx.jsonl.zstd
	// Blocks 1000-1999: 0000/001xxx.jsonl.zstd
	// etc.

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

	filePath := filepath.Join(r.rootDir, millionDir, fileName)

	// Check if file exists
	if _, err := os.Stat(filePath); err != nil {
		return "", fmt.Errorf("file not found for block %d: %s", blockNum, filePath)
	}

	return filePath, nil
}

// openFile opens the zstd compressed file for reading
func (r *BlockReader) openFile(path string) error {
	r.Close() // Close any existing file

	// Use zstd command to decompress
	cmd := exec.Command("zstd", "-d", "-c", path)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("failed to create stdout pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start zstd: %w", err)
	}

	r.currentCmd = cmd
	r.currentReader = bufio.NewScanner(stdout)
	// Set larger buffer for scanner to handle large JSON lines
	r.currentReader.Buffer(make([]byte, 0, 10*1024*1024), 10*1024*1024)

	return nil
}

// NextBlock reads and returns the next block
func (r *BlockReader) NextBlock() (*NormalizedBlock, error) {
	// If in live mode, only read from buffer
	if r.liveMode {
		for {
			if block := r.getBlockFromBuffer(r.nextBlock); block != nil {
				r.nextBlock++
				return block, nil
			}
			// Wait for block to appear in buffer
			time.Sleep(10 * time.Millisecond)
		}
	}

	// Archive mode: read from files
	// If we don't have an open file or need a new one
	if r.currentReader == nil {
		filePath, err := r.findFileForBlock(r.nextBlock)
		if err != nil {
			// Archive file doesn't exist, switch to live mode
			fmt.Printf("Reader: Switching to live mode at block %d\n", r.nextBlock)
			r.liveMode = true
			return r.NextBlock()
		}

		if err := r.openFile(filePath); err != nil {
			return nil, err
		}
	}

	// Read blocks from current file until we find the one we need
	for r.currentReader.Scan() {
		line := r.currentReader.Text()
		if line == "" {
			continue
		}

		var block NormalizedBlock
		decoder := json.NewDecoder(strings.NewReader(line))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&block); err != nil {
			return nil, fmt.Errorf("failed to unmarshal block (strict mode): %w", err)
		}

		// Parse block number
		var blockNum int64
		if err := json.Unmarshal(block.Block.Number, &blockNum); err != nil {
			// Try string format
			var blockNumStr string
			if err := json.Unmarshal(block.Block.Number, &blockNumStr); err != nil {
				return nil, fmt.Errorf("failed to parse block number: %w", err)
			}
			blockNum, err = strconv.ParseInt(blockNumStr, 0, 64)
			if err != nil {
				return nil, fmt.Errorf("failed to parse block number string: %w", err)
			}
		}

		// Skip blocks before our target
		if blockNum < r.nextBlock {
			continue
		}

		// Check for gap
		if blockNum > r.nextBlock {
			return nil, fmt.Errorf("block gap detected: expected %d, got %d", r.nextBlock, blockNum)
		}

		r.nextBlock++
		return &block, nil
	}

	if err := r.currentReader.Err(); err != nil {
		return nil, fmt.Errorf("scanner error: %w", err)
	}

	// End of current file in archive mode
	r.Close()
	// Loop back - will try to open next file or switch to live mode
	return r.NextBlock()
}
