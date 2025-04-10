package main

import (
	"context"
	"flag"
	"fmt"
	"math/big"
	"os"
	"time"

	"github.com/ava-labs/avalanchego/ids"
)

func main() {
	// Command line flags
	rpcURL := flag.String("rpc-url", "http://localhost:9650/ext/bc/PSPJDsDstwafoRHMH4ToeADFWm887WJzUe8shf3S8RLMHCMzZ/rpc", "RPC endpoint URL of the source blockchain")
	blockNum := flag.Uint64("block", 1000, "Block number to parse for Warp messages")
	destChainID := flag.String("dest-chain", "KGAehYuq9J951RHuooVVkiJ3YEMmjpNUKx2SmW5Reb7HdBhNT", "Destination chain ID to filter messages (required)")
	timeoutSec := flag.Uint("timeout", 10, "Timeout in seconds for RPC calls")
	sourceSubnetIDStr := flag.String("source-subnet", "2eob8mVishyekgALVg3g85NDWXHRQ1unYbBrj355MogAd9sUnb", "Source subnet ID to filter messages (required)")
	flag.Parse()

	if *rpcURL == "" {
		fmt.Println("Error: -rpc-url flag is required.")
		flag.Usage()
		os.Exit(1)
	}

	if *destChainID == "" {
		fmt.Println("Error: -dest-chain flag is required.")
		flag.Usage()
		os.Exit(1)
	}

	// Create context with timeout
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(*timeoutSec)*time.Second)
	defer cancel()

	// Parse block for Warp messages
	messages, err := parseBlockWarps(ctx, *rpcURL, big.NewInt(int64(*blockNum)), big.NewInt(int64(*blockNum+1000)), *destChainID)
	if err != nil {
		fmt.Printf("Error parsing block %d: %v\n", *blockNum, err)
		os.Exit(1)
	}

	sourceSubnetID, err := ids.FromString(*sourceSubnetIDStr)
	if err != nil {
		fmt.Printf("Error converting source subnet ID: %v\n", err)
		os.Exit(1)
	}

	aggWrapper, err := NewAggregatorWrapper(sourceSubnetID)
	if err != nil {
		fmt.Printf("Error creating aggregator wrapper: %v\n", err)
		os.Exit(1)
	}

	for _, msg := range messages {
		timeStart := time.Now()
		signed, err := aggWrapper.Sign(ctx, msg)
		if err != nil {
			fmt.Printf("Error aggregating signature: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Signed message: %v\n", signed)
		timeEnd := time.Now()
		fmt.Printf("Time taken: %v\n", timeEnd.Sub(timeStart))
	}

	// Print the result count
	fmt.Printf("Found %d messages\n", len(messages))
}
