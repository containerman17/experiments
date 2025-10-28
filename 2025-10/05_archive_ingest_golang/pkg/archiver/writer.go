package archiver

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

type BlockWriter struct {
	rootDir   string
	fetcher   *Fetcher
	nextBlock int64
}

func NewBlockWriter(rootDir string, fetcher *Fetcher) *BlockWriter {
	writer := &BlockWriter{
		rootDir: rootDir,
		fetcher: fetcher,
	}

	// Find the latest written block
	writer.nextBlock = writer.findLatestWrittenBlock() + 1

	return writer
}

// findLatestWrittenBlock scans existing files to find the highest block number
func (w *BlockWriter) findLatestWrittenBlock() int64 {
	var maxBlock int64 = 0

	// Scan directory structure
	millionDirs, err := os.ReadDir(w.rootDir)
	if err != nil {
		return 0
	}

	for _, millionDir := range millionDirs {
		if !millionDir.IsDir() {
			continue
		}

		millionPath := filepath.Join(w.rootDir, millionDir.Name())
		files, err := os.ReadDir(millionPath)
		if err != nil {
			continue
		}

		for _, file := range files {
			if filepath.Ext(file.Name()) != ".zstd" {
				continue
			}

			// Parse filename to get block range
			// Format: 001xxx.jsonl.zstd means blocks 1000-1999
			var thousands int
			if _, err := fmt.Sscanf(file.Name(), "%03dxxx.jsonl.zstd", &thousands); err == nil {
				// Get the actual last block in this file
				endBlock := int64(thousands*1000 + 999)
				if thousands == 0 {
					endBlock = 999 // First file has blocks 1-999
				}
				if endBlock > maxBlock {
					maxBlock = endBlock
				}
			}
		}
	}

	return maxBlock
}

// getFilePathForBlock returns the path where a block should be written
func (w *BlockWriter) getFilePathForBlock(blockNum int64) string {
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

	return filepath.Join(w.rootDir, millionDir, fileName)
}

// writeBlocks writes accumulated blocks to zstd file
func (w *BlockWriter) writeBlocks(blocks []*NormalizedBlock) error {
	if len(blocks) == 0 {
		return nil
	}

	// Get block number from first block
	var firstBlockNum int64
	decoder := json.NewDecoder(bytes.NewReader(blocks[0].Block.Number))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&firstBlockNum); err != nil {
		var blockNumStr string
		decoder2 := json.NewDecoder(bytes.NewReader(blocks[0].Block.Number))
		decoder2.DisallowUnknownFields()
		if decoder2.Decode(&blockNumStr) == nil {
			firstBlockNum, _ = parseBlockNumber(blockNumStr)
		}
	}

	filePath := w.getFilePathForBlock(firstBlockNum)

	// Create directory if needed
	dir := filepath.Dir(filePath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create directory: %w", err)
	}

	// Write to temp file first
	tempFile := filePath + ".tmp"

	// Create zstd compression pipe
	cmd := exec.Command("zstd", "-c", "-")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("failed to create stdin pipe: %w", err)
	}

	outFile, err := os.Create(tempFile)
	if err != nil {
		return fmt.Errorf("failed to create temp file: %w", err)
	}
	defer outFile.Close()

	cmd.Stdout = outFile

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start zstd: %w", err)
	}

	// Write all blocks as JSONL
	for _, block := range blocks {
		jsonData, err := json.Marshal(block)
		if err != nil {
			stdin.Close()
			cmd.Wait()
			os.Remove(tempFile)
			return fmt.Errorf("failed to marshal block: %w", err)
		}

		if _, err := stdin.Write(jsonData); err != nil {
			stdin.Close()
			cmd.Wait()
			os.Remove(tempFile)
			return fmt.Errorf("failed to write block: %w", err)
		}

		if _, err := stdin.Write([]byte("\n")); err != nil {
			stdin.Close()
			cmd.Wait()
			os.Remove(tempFile)
			return fmt.Errorf("failed to write newline: %w", err)
		}
	}

	stdin.Close()

	if err := cmd.Wait(); err != nil {
		os.Remove(tempFile)
		return fmt.Errorf("zstd compression failed: %w", err)
	}

	// Atomically rename temp file
	if err := os.Rename(tempFile, filePath); err != nil {
		os.Remove(tempFile)
		return fmt.Errorf("failed to rename temp file: %w", err)
	}

	fmt.Printf("Wrote %d blocks to %s\n", len(blocks), filePath)
	return nil
}

// Start begins the writer process
func (w *BlockWriter) Start() error {
	fmt.Printf("Starting writer from block %d\n", w.nextBlock)

	for {
		// Get latest block from chain
		latestBlock, err := w.fetcher.GetLatestBlock()
		if err != nil {
			fmt.Printf("Error getting latest block: %v\n", err)
			time.Sleep(5 * time.Second)
			continue
		}

		blocksAvailable := latestBlock - w.nextBlock + 1

		// Determine end of current file
		var endBlock int64
		if w.nextBlock <= 999 {
			endBlock = 999
		} else {
			endBlock = ((w.nextBlock / 1000) * 1000) + 999
		}

		blocksNeeded := endBlock - w.nextBlock + 1

		if blocksAvailable >= blocksNeeded {
			// Fetch and write complete file
			if err := w.fetchAndWriteBatch(w.nextBlock, endBlock); err != nil {
				fmt.Printf("Error fetching batch: %v\n", err)
				time.Sleep(5 * time.Second)
				continue
			}
			w.nextBlock = endBlock + 1
		} else {
			// Not enough blocks, wait
			fmt.Printf("Waiting for more blocks (need %d, have %d)\n", blocksNeeded, blocksAvailable)
			time.Sleep(5 * time.Second)
		}
	}
}

// fetchAndWriteBatch fetches blocks in parallel and writes them to a file
func (w *BlockWriter) fetchAndWriteBatch(startBlock, endBlock int64) error {
	numBlocks := endBlock - startBlock + 1
	fmt.Printf("Fetching blocks %d-%d (%d blocks)\n", startBlock, endBlock, numBlocks)

	// Fetch all blocks in parallel
	blocks := make([]*NormalizedBlock, numBlocks)
	var wg sync.WaitGroup
	var fetchErr error
	var errMu sync.Mutex

	for i := int64(0); i < numBlocks; i++ {
		wg.Add(1)
		go func(offset int64) {
			defer wg.Done()

			blockNum := startBlock + offset
			block, err := w.fetcher.FetchBlockData(blockNum)
			if err != nil {
				errMu.Lock()
				if fetchErr == nil {
					fetchErr = fmt.Errorf("failed to fetch block %d: %w", blockNum, err)
				}
				errMu.Unlock()
				return
			}

			blocks[offset] = block
		}(i)
	}

	wg.Wait()

	if fetchErr != nil {
		return fetchErr
	}

	// Write blocks to file
	if err := w.writeBlocks(blocks); err != nil {
		return fmt.Errorf("failed to write blocks: %w", err)
	}

	return nil
}

func parseBlockNumber(blockNum string) (int64, error) {
	var num int64
	if _, err := fmt.Sscanf(blockNum, "0x%x", &num); err != nil {
		return 0, fmt.Errorf("failed to parse block number: %w", err)
	}
	return num, nil
}
