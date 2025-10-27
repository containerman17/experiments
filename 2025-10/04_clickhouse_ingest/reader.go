package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
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
}

func NewBlockReader(rootDir string, startFromBlock int64) *BlockReader {
	return &BlockReader{
		rootDir:   rootDir,
		nextBlock: startFromBlock,
	}
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
	// If we don't have an open file or need a new one
	if r.currentReader == nil {
		filePath, err := r.findFileForBlock(r.nextBlock)
		if err != nil {
			return nil, err
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

	// End of current file, try next file
	r.Close()

	// Try to open the next file
	filePath, err := r.findFileForBlock(r.nextBlock)
	if err != nil {
		return nil, io.EOF // No more files
	}

	if err := r.openFile(filePath); err != nil {
		return nil, err
	}

	// Recursively call to read from new file
	return r.NextBlock()
}

// ListAvailableRanges returns the available block ranges in the directory
func ListAvailableRanges(rootDir string) ([]string, error) {
	var ranges []string

	// Read million directories
	millionDirs, err := os.ReadDir(rootDir)
	if err != nil {
		return nil, err
	}

	for _, mDir := range millionDirs {
		if !mDir.IsDir() {
			continue
		}

		million, err := strconv.Atoi(mDir.Name())
		if err != nil {
			continue
		}

		// Read thousand files
		thousandFiles, err := os.ReadDir(filepath.Join(rootDir, mDir.Name()))
		if err != nil {
			continue
		}

		for _, tFile := range thousandFiles {
			if !strings.HasSuffix(tFile.Name(), ".jsonl.zstd") {
				continue
			}

			// Parse thousands from filename (e.g., "345xxx.jsonl.zstd" -> 345)
			parts := strings.Split(tFile.Name(), "xxx")
			if len(parts) != 2 {
				continue
			}

			thousands, err := strconv.Atoi(parts[0])
			if err != nil {
				continue
			}

			startBlock := int64(million*1000000 + thousands*1000)
			endBlock := startBlock + 999

			// Special case for first file (blocks 1-999)
			if million == 0 && thousands == 0 {
				startBlock = 1
				endBlock = 999
			}

			ranges = append(ranges, fmt.Sprintf("%d-%d", startBlock, endBlock))
		}
	}

	sort.Strings(ranges)
	return ranges, nil
}
