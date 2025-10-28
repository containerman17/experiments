package archiver

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

type BlockFeeder interface {
	FeedBlock(block *NormalizedBlock)
}

type BlockWriter struct {
	rootDir     string
	reader      BlockFeeder
	fetcher     *Fetcher
	latestBlock int64
	nextBlock   int64
	accumulator []*NormalizedBlock
}

func NewBlockWriter(rootDir string, reader BlockFeeder, fetcher *Fetcher) *BlockWriter {
	writer := &BlockWriter{
		rootDir:     rootDir,
		reader:      reader,
		fetcher:     fetcher,
		accumulator: make([]*NormalizedBlock, 0, 1000),
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
	if err := json.Unmarshal(blocks[0].Block.Number, &firstBlockNum); err != nil {
		var blockNumStr string
		if json.Unmarshal(blocks[0].Block.Number, &blockNumStr) == nil {
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
	// Get latest block from chain
	latestBlock, err := w.fetcher.GetLatestBlock()
	if err != nil {
		return fmt.Errorf("failed to get latest block: %w", err)
	}
	w.latestBlock = latestBlock

	fmt.Printf("Starting writer from block %d, latest chain block: %d\n", w.nextBlock, w.latestBlock)

	for {
		// Check if we need to update latest block
		if w.nextBlock > w.latestBlock {
			time.Sleep(500 * time.Millisecond)
			latestBlock, err := w.fetcher.GetLatestBlock()
			if err != nil {
				fmt.Printf("Error getting latest block: %v\n", err)
				continue
			}
			w.latestBlock = latestBlock
			continue
		}

		blocksRemaining := w.latestBlock - w.nextBlock + 1

		// Calculate blocks needed to complete current file
		var blocksToFileEnd int64
		if w.nextBlock <= 999 {
			blocksToFileEnd = 999 - w.nextBlock + 1
		} else {
			fileEnd := ((w.nextBlock / 1000) * 1000) + 999
			blocksToFileEnd = fileEnd - w.nextBlock + 1
		}

		// Fast catch-up mode: fetch remaining blocks for current file if we have them all
		if blocksRemaining >= blocksToFileEnd {
			if err := w.fastCatchUp(); err != nil {
				fmt.Printf("Fast catch-up error: %v\n", err)
				time.Sleep(1 * time.Second)
				continue
			}
		} else {
			// Live following mode: fetch block by block
			if err := w.liveFollow(); err != nil {
				fmt.Printf("Live follow error: %v\n", err)
				time.Sleep(1 * time.Second)
				continue
			}
		}
	}
}

// fastCatchUp fetches blocks to complete a file (up to 1000) and writes them
func (w *BlockWriter) fastCatchUp() error {
	startBlock := w.nextBlock

	// Determine the end of the current file
	var endBlock int64
	if startBlock <= 999 {
		// First file: blocks 1-999
		endBlock = 999
	} else {
		// Subsequent files: align to 1000-block boundaries
		// e.g., blocks 1000-1999, 2000-2999, 3000-3999
		fileEnd := ((startBlock / 1000) * 1000) + 999
		endBlock = fileEnd
	}

	numBlocks := endBlock - startBlock + 1
	fmt.Printf("Fast catch-up: fetching blocks %d-%d (%d blocks)\n", startBlock, endBlock, numBlocks)

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

	// Feed blocks to reader buffer in order
	for _, block := range blocks {
		w.reader.FeedBlock(block)
	}

	w.nextBlock = endBlock + 1
	return nil
}

// liveFollow fetches blocks one by one and accumulates them
func (w *BlockWriter) liveFollow() error {
	block, err := w.fetcher.FetchBlockData(w.nextBlock)
	if err != nil {
		return fmt.Errorf("failed to fetch block %d: %w", w.nextBlock, err)
	}

	// Add to accumulator
	w.accumulator = append(w.accumulator, block)

	// Feed to reader immediately
	w.reader.FeedBlock(block)

	// Check if we need to write (crossing 1000-block boundary)
	if w.nextBlock%1000 == 999 || (w.nextBlock <= 999 && w.nextBlock == 999) {
		// Write accumulated blocks
		if err := w.writeBlocks(w.accumulator); err != nil {
			return fmt.Errorf("failed to write blocks: %w", err)
		}
		w.accumulator = make([]*NormalizedBlock, 0, 1000)
	}

	w.nextBlock++

	// If caught up, pause briefly
	if w.nextBlock > w.latestBlock {
		time.Sleep(500 * time.Millisecond)
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
