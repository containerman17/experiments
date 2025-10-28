package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"ingest/pkg/rpc"
	"log"
	"os"
	"time"
)

func main() {
	// Parse command line arguments
	rpcURL := flag.String("rpc", "", "RPC endpoint URL (required)")
	from := flag.Int64("from", 0, "Starting block number")
	to := flag.Int64("to", 0, "Ending block number")
	batchSize := flag.Int("batch", 100, "Batch size for regular RPC calls")
	debugBatchSize := flag.Int("debug-batch", 10, "Batch size for debug RPC calls")
	rpcConcurrency := flag.Int("rpc-concurrency", 10, "Number of concurrent RPC batches")
	debugConcurrency := flag.Int("debug-concurrency", 2, "Number of concurrent debug batches")
	outputFile := flag.String("output", "", "Output JSON file (optional)")

	flag.Parse()

	if *rpcURL == "" {
		fmt.Fprintf(os.Stderr, "Error: -rpc flag is required\n")
		flag.Usage()
		os.Exit(1)
	}

	// Create fetcher with configuration
	fetcher := rpc.NewFetcher(rpc.FetcherOptions{
		RpcURL:           *rpcURL,
		RpcConcurrency:   *rpcConcurrency,
		DebugConcurrency: *debugConcurrency,
		BatchSize:        *batchSize,
		DebugBatchSize:   *debugBatchSize,
	})

	// If no range specified, get the latest block
	if *from == 0 && *to == 0 {
		latest, err := fetcher.GetLatestBlock()
		if err != nil {
			log.Fatalf("Failed to get latest block: %v", err)
		}
		*from = latest - 10 // Default to last 10 blocks
		*to = latest
		fmt.Printf("No range specified, using blocks %d to %d\n", *from, *to)
	} else if *to == 0 {
		*to = *from // Single block if only from is specified
	}

	fmt.Printf("Fetching blocks %d to %d with batch size %d\n", *from, *to, *batchSize)
	fmt.Printf("RPC concurrency: %d, Debug concurrency: %d\n", *rpcConcurrency, *debugConcurrency)

	// Start timing
	startTime := time.Now()

	// Fetch the block range
	blocks, err := fetcher.FetchBlockRange(*from, *to)
	if err != nil {
		log.Fatalf("Failed to fetch block range: %v", err)
	}

	// Calculate statistics
	elapsed := time.Since(startTime)
	numBlocks := len(blocks)
	var totalTxs int
	var totalTraces int

	for _, block := range blocks {
		totalTxs += len(block.Block.Transactions)
		for _, trace := range block.Traces {
			if trace.Result != nil {
				totalTraces++
			}
		}
	}

	fmt.Printf("\n=== Fetch Complete ===\n")
	fmt.Printf("Time elapsed: %v\n", elapsed)
	fmt.Printf("Blocks fetched: %d\n", numBlocks)
	fmt.Printf("Total transactions: %d\n", totalTxs)
	fmt.Printf("Total traces: %d\n", totalTraces)
	fmt.Printf("Average time per block: %v\n", elapsed/time.Duration(numBlocks))

	if numBlocks > 0 {
		fmt.Printf("Blocks/second: %.2f\n", float64(numBlocks)/elapsed.Seconds())
		if totalTxs > 0 {
			fmt.Printf("Transactions/second: %.2f\n", float64(totalTxs)/elapsed.Seconds())
		}
	}

	// Output to file if requested
	if *outputFile != "" {
		file, err := os.Create(*outputFile)
		if err != nil {
			log.Fatalf("Failed to create output file: %v", err)
		}
		defer file.Close()

		encoder := json.NewEncoder(file)
		encoder.SetIndent("", "  ")
		if err := encoder.Encode(blocks); err != nil {
			log.Fatalf("Failed to write JSON output: %v", err)
		}
		fmt.Printf("\nOutput written to %s\n", *outputFile)
	}

	// Print sample of first block
	if len(blocks) > 0 && len(blocks[0].Block.Transactions) > 0 {
		fmt.Printf("\n=== Sample: First Block ===\n")
		fmt.Printf("Block Hash: %s\n", blocks[0].Block.Hash)
		fmt.Printf("Block Number: %s\n", blocks[0].Block.Number)
		fmt.Printf("Transaction Count: %d\n", len(blocks[0].Block.Transactions))
		if len(blocks[0].Block.Transactions) > 0 {
			fmt.Printf("First Tx Hash: %s\n", blocks[0].Block.Transactions[0].Hash)
		}
	}
}
