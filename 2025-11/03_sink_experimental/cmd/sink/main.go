package main

import (
	"bytes"
	"context"
	"encoding/json"
	"evm-sink/api"
	"evm-sink/consts"
	"evm-sink/rpc"
	"evm-sink/storage"
	"flag"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

func main() {
	configPath := flag.String("config", "config.yaml", "path to config file")
	flag.Parse()

	// Load config
	configData, err := os.ReadFile(*configPath)
	if err != nil {
		log.Fatalf("Failed to read config: %v", err)
	}

	var cfg rpc.Config
	decoder := yaml.NewDecoder(bytes.NewReader(configData))
	decoder.KnownFields(true)
	if err := decoder.Decode(&cfg); err != nil {
		log.Fatalf("Failed to parse config: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Initialize storage
	store, err := storage.NewStorage(cfg.PebblePath)
	if err != nil {
		log.Fatalf("Failed to open storage: %v", err)
	}
	defer store.Close()

	// Initialize S3
	s3Client, err := storage.NewS3Client(ctx, storage.S3Config{
		Bucket:    cfg.S3Bucket,
		Region:    cfg.S3Region,
		Endpoint:  cfg.S3Endpoint,
		AccessKey: cfg.S3AccessKey,
		SecretKey: cfg.S3SecretKey,
	})
	if err != nil {
		log.Fatalf("Failed to create S3 client: %v", err)
	}

	// Initialize API server
	server := api.NewServer(store, s3Client, cfg.S3Prefix)

	// Start ingesters and compactors for each chain

	for _, chainCfg := range cfg.Chains {
		chainID := chainCfg.ChainID
		chainName := chainCfg.Name

		// Register chain with server
		server.RegisterChain(chainID, chainName)

		if chainCfg.URL == "" {
			log.Printf("[Chain %d - %s] No URL configured, skipping", chainID, chainName)
			continue
		}

		controller := rpc.NewController(chainCfg)

		// Create fetcher (includes WebSocket head tracker)
		fetcher, err := rpc.NewFetcher(rpc.FetcherConfig{
			Controller: controller,
			ChainID:    chainID,
			ChainName:  chainName,
			Ctx:        ctx,
		})
		if err != nil {
			log.Printf("[Chain %d - %s] Failed to create fetcher: %v, skipping", chainID, chainName, err)
			continue
		}

		// Start compactor
		compactor := storage.NewCompactor(store, s3Client, chainID, cfg.S3Prefix)
		compactor.Start(ctx)

		// Start ingestion loop
		lookahead := chainCfg.Lookahead
		if lookahead <= 0 {
			lookahead = cfg.DefaultLookahead
		}
		if lookahead <= 0 {
			lookahead = 100 // fallback default
		}
		go func(chainID uint64, chainName string, lookahead int) {
			runIngestion(ctx, fetcher, store, s3Client, server, chainID, chainName, cfg.S3Prefix, lookahead)
		}(chainID, chainName, lookahead)

		log.Printf("[Chain %d - %s] Started ingestion", chainID, chainName)
	}

	// Start API server
	if err := server.Start(consts.ServerListenAddr); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}

	// Block forever - Ctrl+C just kills the process
	select {}
}

func runIngestion(ctx context.Context, fetcher *rpc.Fetcher, store *storage.Storage, s3Client *storage.S3Client, server *api.Server, chainID uint64, chainName string, s3Prefix string, lookahead int) {
	// Retry loop - if streaming fails, restart from last saved block
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		// Determine starting block: PebbleDB > S3 > block 1
		currentBlock := uint64(1)
		if latest, ok := store.LatestBlock(chainID); ok {
			currentBlock = latest + 1
			log.Printf("[Chain %d - %s] Resuming from PebbleDB at block %d", chainID, chainName, currentBlock)
		} else if latestS3, err := s3Client.FindLatestBatch(ctx, s3Prefix, chainID); err == nil && latestS3 > 0 {
			currentBlock = latestS3 + 1
			log.Printf("[Chain %d - %s] Resuming from S3 at block %d", chainID, chainName, currentBlock)
		} else {
			log.Printf("[Chain %d - %s] Starting from block 1", chainID, chainName)
		}

		blocksCh := make(chan *rpc.NormalizedBlock, lookahead)

		// Start streaming
		go func() {
			if err := fetcher.StreamBlocks(ctx, currentBlock, lookahead, blocksCh); err != nil {
				log.Printf("[Chain %d - %s] Stream error: %v", chainID, chainName, err)
			}
			close(blocksCh)
		}()

		// Track stats
		startTime := time.Now()
		startBlock := currentBlock
		lastLogTime := time.Now()

		for block := range blocksCh {
			// Extract block number from the block itself - don't trust counters
			blockNum, err := parseBlockNumber(block.Block.Number)
			if err != nil {
				log.Printf("[Chain %d - %s] Failed to parse block number: %v", chainID, chainName, err)
				break // Stop and retry - something is very wrong
			}

			// Verify ordering
			if blockNum != currentBlock {
				log.Printf("[Chain %d - %s] Block number mismatch: expected %d, got %d", chainID, chainName, currentBlock, blockNum)
				break // Stop and retry from PebbleDB
			}

			data, err := json.Marshal(block)
			if err != nil {
				log.Printf("[Chain %d - %s] Failed to marshal block %d: %v", chainID, chainName, blockNum, err)
				break // Stop and retry - marshal should never fail
			}

			if err := store.SaveBlock(chainID, blockNum, data); err != nil {
				log.Printf("[Chain %d - %s] Failed to save block %d: %v", chainID, chainName, blockNum, err)
				break // Stop and retry - DB write failed
			}

			server.UpdateLatestBlock(chainID, blockNum)
			currentBlock++

			// Log progress every 5 seconds
			if time.Since(lastLogTime) >= 5*time.Second {
				lastLogTime = time.Now()

				totalElapsed := time.Since(startTime)
				totalBlocks := currentBlock - startBlock
				avgBlocksPerSec := float64(totalBlocks) / totalElapsed.Seconds()

				latestBlock, _ := fetcher.GetLatestBlock(ctx)
				blocksRemaining := int64(latestBlock) - int64(currentBlock) + 1
				if blocksRemaining < 0 {
					blocksRemaining = 0
				}
				eta := time.Duration(float64(blocksRemaining)/avgBlocksPerSec) * time.Second

				log.Printf("[Chain %d - %s] block %d | %.1f blk/s avg | %d behind, eta %s | p=%d p95=%dms",
					chainID, chainName, currentBlock-1,
					avgBlocksPerSec, blocksRemaining, formatDuration(eta),
					fetcher.Controller().CurrentParallelism(),
					fetcher.Controller().P95Latency().Milliseconds())
			}
		}

		// Stream ended - wait and retry
		log.Printf("[Chain %d - %s] Ingestion stopped, restarting in 5s...", chainID, chainName)
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
		}
	}
}

func parseBlockNumber(hexNum string) (uint64, error) {
	numStr := strings.TrimPrefix(hexNum, "0x")
	return strconv.ParseUint(numStr, 16, 64)
}

func formatDuration(d time.Duration) string {
	if d < time.Minute {
		return d.Round(time.Second).String()
	}
	d = d.Round(time.Minute)
	days := d / (24 * time.Hour)
	d -= days * 24 * time.Hour
	hours := d / time.Hour
	d -= hours * time.Hour
	minutes := d / time.Minute

	if days > 0 {
		return fmt.Sprintf("%dd%dh%dm", days, hours, minutes)
	}
	if hours > 0 {
		return fmt.Sprintf("%dh%dm", hours, minutes)
	}
	return fmt.Sprintf("%dm", minutes)
}
