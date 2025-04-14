package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"math/big"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ava-labs/avalanchego/ids"
	"github.com/ava-labs/avalanchego/utils/set"
	avalancheWarp "github.com/ava-labs/avalanchego/vms/platformvm/warp"
	"github.com/ava-labs/avalanchego/vms/platformvm/warp/payload"
	teleportermessenger "github.com/ava-labs/icm-contracts/abi-bindings/go/teleporter/TeleporterMessenger"
	basecfg "github.com/ava-labs/icm-services/config"
	"github.com/ava-labs/icm-services/types"
	"github.com/ava-labs/subnet-evm/ethclient"
	"github.com/ava-labs/subnet-evm/interfaces"
	subnetWarp "github.com/ava-labs/subnet-evm/precompile/contracts/warp"
	"github.com/containerman17/experiments/2025-04/turborelayer-mvp/aggregator"
	"github.com/ethereum/go-ethereum/common"
)

const (
	batchSize = 1000
	// Default number of worker goroutines to use for signature aggregation
	defaultWorkerCount              = 200
	defaultRequiredQuorumPercentage = 67
	defaultQuorumPercentageBuffer   = 3
)

func main() {
	// Command line flags
	rpcURL := flag.String("rpc-url", SOURCE_RPC_URL, "RPC endpoint URL of the source blockchain")
	startBlock := flag.Uint64("start-block", 1, "Start block number to parse for Warp messages")
	endBlock := flag.Uint64("end-block", 0, "End block number to parse for Warp messages")
	destChainID := flag.String("dest-chain", "KGAehYuq9J951RHuooVVkiJ3YEMmjpNUKx2SmW5Reb7HdBhNT", "Destination chain ID to filter messages (required)")
	timeoutSec := flag.Uint("timeout", 60, "Overall timeout in seconds for the operation")
	sourceSubnetIDStr := flag.String("source-subnet", "2eob8mVishyekgALVg3g85NDWXHRQ1unYbBrj355MogAd9sUnb", "Signing subnet ID (required)")
	workerCount := flag.Int("workers", defaultWorkerCount, "Number of concurrent workers for signature aggregation")
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

	if *sourceSubnetIDStr == "" {
		fmt.Println("Error: -source-subnet flag is required.")
		flag.Usage()
		os.Exit(1)
	}

	if *endBlock <= *startBlock && *endBlock != 0 {
		fmt.Println("Error: -end-block must be greater than -start-block.")
		os.Exit(1)
	}

	sourceSubnetID, err := ids.FromString(*sourceSubnetIDStr)
	if err != nil {
		fmt.Printf("Error converting source subnet ID: %v\n", err)
		os.Exit(1)
	}

	// Create context with overall timeout
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(*timeoutSec)*time.Second)
	defer cancel()

	// Initialize Aggregator Wrapper
	aggWrapper, err := aggregator.NewAggregatorWrapper(sourceSubnetID)
	if err != nil {
		fmt.Printf("Error creating aggregator wrapper: %v\n", err)
		os.Exit(1)
	}

	// Initialize connection to validators (done once at startup)
	fmt.Printf("Pre-connecting to validators for subnet %s...\n", sourceSubnetID)
	initCtx, initCancel := context.WithTimeout(ctx, 15*time.Second)
	defer initCancel()

	err = aggWrapper.SigAgg.InitializeSubnetConnections(initCtx, []ids.ID{sourceSubnetID}, defaultRequiredQuorumPercentage)
	if err != nil {
		fmt.Printf("Warning: Pre-connection to validators failed: %v\n", err)
		// Continue anyway, connections will be established on-demand
	}

	// Set default quorum parameters
	aggWrapper.SigAgg.SetDefaultQuorumParameters(defaultRequiredQuorumPercentage, defaultQuorumPercentageBuffer)

	// Parse block range for Warp messages
	parseStart := time.Now()
	messages, err := parseBlockWarps(ctx, *rpcURL, big.NewInt(int64(*startBlock)), big.NewInt(int64(*endBlock)), *destChainID)
	if err != nil {
		fmt.Printf("Error parsing block range %d-%d: %v\n", *startBlock, *endBlock, err)
		os.Exit(1)
	}
	parseEnd := time.Now()
	fmt.Printf("Parsed %d messages from blocks %d-%d in %v\n", len(messages), *startBlock, *endBlock, parseEnd.Sub(parseStart))

	if len(messages) == 0 {
		fmt.Println("No messages found to sign.")
		return
	}

	// Use worker pool instead of unlimited goroutines
	workers := *workerCount
	if workers <= 0 {
		workers = defaultWorkerCount
	}

	// Aggregate signatures using worker pool
	fmt.Printf("Aggregating signatures for %d messages using %d workers...\n", len(messages), workers)
	overallAggregationStart := time.Now()

	// Create work channels
	jobs := make(chan *avalancheWarp.UnsignedMessage, len(messages))
	results := make(chan signResult, len(messages))

	// Start workers
	var wg sync.WaitGroup
	for w := 1; w <= workers; w++ {
		wg.Add(1)
		go worker(ctx, w, &wg, aggWrapper, jobs, results)
	}

	// Add all jobs to the queue
	for _, msg := range messages {
		jobs <- msg
	}
	close(jobs)

	// Setup progress tracking
	var (
		completedCount     atomic.Int64
		successCount       int
		failureCount       int
		progressTicker     = time.NewTicker(1 * time.Second)
		progressDone       = make(chan struct{})
		lastCompletedCount int64
	)

	// Start progress reporter
	go func() {
		defer close(progressDone)
		for {
			select {
			case <-ctx.Done():
				return
			case <-progressTicker.C:
				current := completedCount.Load()
				messagesPerSecond := current - lastCompletedCount
				lastCompletedCount = current
				fmt.Printf("Progress: %d/%d messages completed (%d/sec)\n",
					current, len(messages), messagesPerSecond)
			}
		}
	}()

	// Process results in main goroutine
	go func() {
		for result := range results {
			if result.err == nil {
				successCount++
			} else {
				failureCount++
			}
			completedCount.Add(1)
		}
		// Signal completion to the progress reporter
		progressTicker.Stop()
		close(progressDone)
	}()

	// Wait for all workers to complete
	wg.Wait()
	close(results)

	// Wait for result processing to finish
	<-progressDone

	overallAggregationEnd := time.Now()
	fmt.Printf("Finished all signature aggregation: %d succeeded, %d failed, total time: %v\n",
		successCount, failureCount, overallAggregationEnd.Sub(overallAggregationStart))
}

// Result type for signature aggregation
type signResult struct {
	messageID string
	err       error
}

// Worker function that processes jobs from the channel
func worker(ctx context.Context, id int, wg *sync.WaitGroup, aggWrapper *aggregator.AggregatorWrapper, jobs <-chan *avalancheWarp.UnsignedMessage, results chan<- signResult) {
	defer wg.Done()

	for msg := range jobs {
		// Process the message
		signed, err := aggWrapper.Sign(ctx, msg)

		if err != nil {
			// log.Printf("[Worker %d] Error signing Warp ID %s: %v (took %v)\n",
			// 	id, msg.ID(), err, timeEnd.Sub(timeStart))
			results <- signResult{messageID: msg.ID().String(), err: err}
		} else {
			_ = signed // We don't need to use the signed message, just want the signature aggregation
			// log.Printf("[Worker %d] Signed Warp ID %s (took %v)\n",
			// 	id, signed.ID(), timeEnd.Sub(timeStart))
			results <- signResult{messageID: msg.ID().String(), err: nil}
		}
	}
}

const (
	defaultAppTimeout     = 15 * time.Second // Timeout for each aggregation call
	defaultConnectTimeout = 10 * time.Second // Timeout for initial node info calls
)

// --- Minimal Config Implementation for Peers ---
type minimalPeerConfig struct {
	infoAPI   *basecfg.APIConfig
	pchainAPI *basecfg.APIConfig
}

func (m *minimalPeerConfig) GetInfoAPI() *basecfg.APIConfig     { return m.infoAPI }
func (m *minimalPeerConfig) GetPChainAPI() *basecfg.APIConfig   { return m.pchainAPI }
func (m *minimalPeerConfig) GetAllowPrivateIPs() bool           { return true }
func (m *minimalPeerConfig) GetTrackedSubnets() set.Set[ids.ID] { return set.NewSet[ids.ID](1) } // Minimal
func (m *minimalPeerConfig) GetTLSCert() *tls.Certificate       { return nil }

// Note: Shutdown method removed as the network reference is no longer stored.
// The network's lifecycle is implicitly managed by the SignatureAggregator.

var WarpPrecompileLogFilter = subnetWarp.WarpABI.Events["SendWarpMessage"].ID

func parseBlockWarps(ctx context.Context, rpcURL string, fromBlock *big.Int, toBlock *big.Int, destChainIDStr string) ([]*avalancheWarp.UnsignedMessage, error) {
	if rpcURL == "" {
		return nil, errors.New("RPC URL cannot be empty")
	}

	client, err := ethclient.DialContext(ctx, rpcURL)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to RPC endpoint: %w", err)
	}
	defer client.Close()

	// If toBlock is zero, fetch the latest block number
	if toBlock.Cmp(big.NewInt(0)) == 0 {
		latestBlock, err := client.BlockNumber(ctx)
		if err != nil {
			return nil, fmt.Errorf("failed to get latest block number: %w", err)
		}
		toBlock = big.NewInt(int64(latestBlock))
	}

	query := interfaces.FilterQuery{
		FromBlock: fromBlock,
		ToBlock:   toBlock,
		Addresses: []common.Address{subnetWarp.ContractAddress},
		Topics:    [][]common.Hash{{WarpPrecompileLogFilter}},
	}

	logs, err := client.FilterLogs(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to filter logs for block %d: %w", fromBlock, err)
	}

	var unsignedMessages []*avalancheWarp.UnsignedMessage
	for _, l := range logs {
		if len(l.Topics) == 0 || l.Topics[0] != WarpPrecompileLogFilter || l.Address != subnetWarp.ContractAddress {
			continue
		}

		unsignedMsg, err := types.UnpackWarpMessage(l.Data)
		if err != nil {
			continue // Skip if basic warp message parsing fails
		}

		// Attempt to parse payload for filtering
		addressedPayload, err := payload.ParseAddressedCall(unsignedMsg.Payload)
		if err != nil {
			continue // Cannot determine destination, skip
		}

		var teleporterMessage teleportermessenger.TeleporterMessage
		err = teleporterMessage.Unpack(addressedPayload.Payload)
		if err != nil {
			continue // Not a teleporter message, cannot filter by dest chain ID, skip
		}

		// Successfully parsed Teleporter message, check destination chain
		chainID, err := ids.ToID(teleporterMessage.DestinationBlockchainID[:])
		if err != nil {
			continue // Error converting chain ID, skip
		}

		if chainID.String() == destChainIDStr {
			unsignedMessages = append(unsignedMessages, unsignedMsg)
		}
	}

	return unsignedMessages, nil
}
