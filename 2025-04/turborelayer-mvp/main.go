package main

import (
	"context"
	"fmt"
	"math/big"
	"os"
	"sync"
	"time"

	"github.com/ava-labs/avalanchego/ids"
	avalancheWarp "github.com/ava-labs/avalanchego/vms/platformvm/warp"
	"github.com/ava-labs/subnet-evm/ethclient"
	"github.com/containerman17/experiments/2025-04/turborelayer-mvp/aggregator"
)

func main() {
	sourceSubnetID, err := ids.FromString(SOURCE_SUBNET)
	if err != nil {
		fmt.Printf("Error converting source subnet ID: %v\n", err)
		os.Exit(1)
	}

	// Create context with overall timeout
	ctx := context.TODO()

	// Initialize Aggregator Wrapper
	aggWrapper, err := aggregator.NewAggregatorWrapper(sourceSubnetID)
	if err != nil {
		fmt.Printf("Error creating aggregator wrapper: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Processing blocks %d to %d...\n", START_BLOCK, END_BLOCK)
	startTime := time.Now()

	successCount := 0
	failureCount := 0

	client, err := ethclient.DialContext(ctx, SOURCE_RPC_URL)
	if err != nil {
		fmt.Printf("failed to connect to RPC endpoint: %v\n", err)
		os.Exit(1)
	}
	defer client.Close()

	for blockNum := START_BLOCK; blockNum <= END_BLOCK; blockNum++ {
		blockNumBig := big.NewInt(int64(blockNum))
		success, failure := handleBlock(ctx, blockNumBig, aggWrapper, client)

		successCount += success
		failureCount += failure

		fmt.Printf("Block %d processed: %d succeeded, %d failed\n", blockNum, success, failure)
	}

	duration := time.Since(startTime)
	fmt.Printf("Finished processing all blocks: %d succeeded, %d failed, total time: %v\n",
		successCount, failureCount, duration)
}

func handleBlock(ctx context.Context, blockNumber *big.Int, aggWrapper *aggregator.AggregatorWrapper, client ethclient.Client) (int, int) {
	successCount := 0
	failureCount := 0

	// Parse Warp messages from the block
	messages, err := parseBlockWarps(ctx, SOURCE_RPC_URL, blockNumber, DEST_CHAIN, client)
	if err != nil {
		fmt.Printf("Error parsing block %s: %v\n", blockNumber.String(), err)
		return 0, 0
	}

	if len(messages) == 0 {
		return 0, 0
	}

	// Process messages in parallel
	var wg sync.WaitGroup
	var mu sync.Mutex // Mutex to protect concurrent access to counters

	for _, msg := range messages {
		wg.Add(1)
		go func(message *avalancheWarp.UnsignedMessage) {
			defer wg.Done()

			// Sign the message
			signed, err := aggWrapper.Sign(ctx, message)

			mu.Lock()
			defer mu.Unlock()

			if err != nil {
				fmt.Printf("Error signing Warp ID %s: %v\n", message.ID(), err)
				failureCount++
			} else {
				_ = signed // We don't need to use the signed message, just want the signature aggregation
				successCount++
			}
		}(msg)
	}

	wg.Wait() // Wait for all goroutines to complete

	return successCount, failureCount
}
