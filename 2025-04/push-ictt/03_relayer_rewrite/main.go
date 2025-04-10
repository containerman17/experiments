package main

import (
	"context"
	"flag"
	"fmt"
	"math/big"
	"os"
	"time"
)

func main() {
	// Command line flags
	rpcURL := flag.String("rpc-url", "http://localhost:9650/ext/bc/PSPJDsDstwafoRHMH4ToeADFWm887WJzUe8shf3S8RLMHCMzZ/rpc", "RPC endpoint URL of the source blockchain")
	blockNum := flag.Uint64("block", 1000, "Block number to parse for Warp messages")
	destChainID := flag.String("dest-chain", "KGAehYuq9J951RHuooVVkiJ3YEMmjpNUKx2SmW5Reb7HdBhNT", "Destination chain ID to filter messages (required)")
	timeoutSec := flag.Uint("timeout", 10, "Timeout in seconds for RPC calls")
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
	messages, err := parseBlockWarps(ctx, *rpcURL, big.NewInt(int64(*blockNum)), *destChainID)
	if err != nil {
		fmt.Printf("Error parsing block %d: %v\n", *blockNum, err)
		os.Exit(1)
	}

	// Print the result count
	fmt.Printf("Found %d messages\n", len(messages))
}
