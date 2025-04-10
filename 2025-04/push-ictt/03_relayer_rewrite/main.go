package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"log"
	"math/big"
	"os"
	"sync"
	"time"

	"hello/aggregator"

	"github.com/ava-labs/avalanchego/api/info"
	"github.com/ava-labs/avalanchego/ids"
	"github.com/ava-labs/avalanchego/message"
	"github.com/ava-labs/avalanchego/network/peer"
	"github.com/ava-labs/avalanchego/utils/constants"
	"github.com/ava-labs/avalanchego/utils/logging"
	"github.com/ava-labs/avalanchego/utils/set"
	"github.com/ava-labs/avalanchego/vms/platformvm"
	avalancheWarp "github.com/ava-labs/avalanchego/vms/platformvm/warp"
	"github.com/ava-labs/avalanchego/vms/platformvm/warp/payload"
	teleportermessenger "github.com/ava-labs/icm-contracts/abi-bindings/go/teleporter/TeleporterMessenger"
	basecfg "github.com/ava-labs/icm-services/config"
	"github.com/ava-labs/icm-services/peers"
	peerUtils "github.com/ava-labs/icm-services/peers/utils"
	sigAggMetrics "github.com/ava-labs/icm-services/signature-aggregator/metrics"
	"github.com/ava-labs/icm-services/types"
	"github.com/ava-labs/subnet-evm/ethclient"
	"github.com/ava-labs/subnet-evm/interfaces"
	subnetWarp "github.com/ava-labs/subnet-evm/precompile/contracts/warp"
	"github.com/ethereum/go-ethereum/common"
	"github.com/prometheus/client_golang/prometheus"
)

const (
	batchSize = 1000
)

func main() {
	// Command line flags
	rpcURL := flag.String("rpc-url", "http://localhost:9650/ext/bc/PSPJDsDstwafoRHMH4ToeADFWm887WJzUe8shf3S8RLMHCMzZ/rpc", "RPC endpoint URL of the source blockchain")
	startBlock := flag.Uint64("start-block", 1, "Start block number to parse for Warp messages")
	endBlock := flag.Uint64("end-block", 0, "End block number to parse for Warp messages")
	destChainID := flag.String("dest-chain", "KGAehYuq9J951RHuooVVkiJ3YEMmjpNUKx2SmW5Reb7HdBhNT", "Destination chain ID to filter messages (required)")
	timeoutSec := flag.Uint("timeout", 60, "Overall timeout in seconds for the operation")
	sourceSubnetIDStr := flag.String("source-subnet", "2eob8mVishyekgALVg3g85NDWXHRQ1unYbBrj355MogAd9sUnb", "Signing subnet ID (required)")
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
	aggWrapper, err := NewAggregatorWrapper(sourceSubnetID)
	if err != nil {
		fmt.Printf("Error creating aggregator wrapper: %v\n", err)
		os.Exit(1)
	}

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

	// Aggregate signatures in batches
	fmt.Printf("Aggregating signatures for %d messages in batches of %d...\n", len(messages), batchSize)
	overallAggregationStart := time.Now()

	numMessages := len(messages)
	for i := 0; i < numMessages; i += batchSize {
		batchStart := time.Now()
		batchEnd := i + batchSize
		if batchEnd > numMessages {
			batchEnd = numMessages
		}
		batch := messages[i:batchEnd]
		batchNum := (i / batchSize) + 1
		numInBatch := len(batch)

		var wg sync.WaitGroup
		for j, msg := range batch {
			currentIndex := i + j // Overall index
			wg.Add(1)
			go func(m *avalancheWarp.UnsignedMessage, batchIndex int, overallIndex int) {
				defer wg.Done()
				timeStart := time.Now()
				signed, err := aggWrapper.Sign(ctx, m) // Use the overall context
				timeEnd := time.Now()
				if err != nil {
					fmt.Printf("[Batch %d, Msg %d/%d (Overall %d)] Error signing Warp ID %s: %v (took %v)\n",
						batchNum, batchIndex+1, numInBatch, overallIndex+1, m.ID(), err, timeEnd.Sub(timeStart))
					return
				}
				_ = signed
				// fmt.Printf("[Batch %d, Msg %d/%d (Overall %d)] Signed Warp ID %s (took %v)\n",
				// 	batchNum, batchIndex+1, numInBatch, overallIndex+1, signed.ID(), timeEnd.Sub(timeStart))
			}(msg, j, currentIndex)
		}

		// Wait for the current batch to complete
		wg.Wait()
		batchTime := time.Since(batchStart)
		fmt.Printf("--- Finished Batch %d (%d messages) in %v ---\n", batchNum, numInBatch, batchTime)
	}

	overallAggregationEnd := time.Now()
	fmt.Printf("Finished all signature aggregation batches in %v\n", overallAggregationEnd.Sub(overallAggregationStart))
}

const (
	localNodeURL                    = "http://localhost:9650"
	defaultRequiredQuorumPercentage = 67
	defaultQuorumPercentageBuffer   = 3
	defaultAppTimeout               = 15 * time.Second // Timeout for each aggregation call
	defaultConnectTimeout           = 10 * time.Second // Timeout for initial node info calls
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

// --- Aggregator Wrapper ---

type AggregatorWrapper struct {
	sigAgg          *aggregator.SignatureAggregator
	signingSubnetID ids.ID
}

// NewAggregatorWrapper creates and initializes the necessary components
// for signature aggregation, returning a wrapper.
func NewAggregatorWrapper(signingSubnetID ids.ID) (*AggregatorWrapper, error) {
	// Use Background context for long-running network setup/info calls
	setupCtx, cancel := context.WithTimeout(context.Background(), defaultConnectTimeout)
	defer cancel()

	// --- Basic Setup ---
	logLevel := logging.Error // Or configure as needed
	logger := logging.NewLogger(
		"aggregator-wrapper",
		logging.NewWrappedCore(logLevel, os.Stdout, logging.JSON.ConsoleEncoder()),
	)
	networkLogger := logging.NewLogger(
		"p2p-network-wrapper",
		logging.NewWrappedCore(logLevel, os.Stdout, logging.JSON.ConsoleEncoder()),
	)

	// --- API Clients ---
	infoClient := info.NewClient(localNodeURL)
	pchainClient := platformvm.NewClient(localNodeURL)
	pchainRPCOptions := peerUtils.InitializeOptions(&basecfg.APIConfig{})

	// --- Get Local Node Info ---
	localNodeID, _, err := infoClient.GetNodeID(setupCtx)
	if err != nil {
		return nil, fmt.Errorf("failed to get local node ID: %w", err)
	}
	localNodeIP, err := infoClient.GetNodeIP(setupCtx)
	if err != nil {
		return nil, fmt.Errorf("failed to get local node IP: %w", err)
	}
	log.Printf("Using local node: ID=%s, IP=%s", localNodeID, localNodeIP)

	// --- Peer Network Setup ---
	peerCfg := &minimalPeerConfig{
		infoAPI:   &basecfg.APIConfig{BaseURL: localNodeURL},
		pchainAPI: &basecfg.APIConfig{BaseURL: localNodeURL},
	}
	registry := prometheus.NewRegistry() // Dummy registry for example
	trackedSubnets := set.NewSet[ids.ID](1)
	trackedSubnets.Add(signingSubnetID)
	manuallyTrackedPeers := []info.Peer{
		{Info: peer.Info{ID: localNodeID, PublicIP: localNodeIP}},
	}

	msgCreator, err := message.NewCreator(
		logger,
		registry,
		constants.DefaultNetworkCompressionType,
		constants.DefaultNetworkMaximumInboundTimeout,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create message creator: %w", err)
	}

	// Create the network; it will be managed internally by the aggregator
	network, err := peers.NewNetwork(
		networkLogger,
		registry,
		trackedSubnets,
		manuallyTrackedPeers,
		peerCfg,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create app request network: %w", err)
	}

	// Explicitly track the signing subnet (might be redundant if in initial set)
	network.TrackSubnet(signingSubnetID)

	log.Printf("Number of connected peers: %d", network.NumConnectedPeers())
	if network.NumConnectedPeers() == 0 {
		log.Println("WARN: No peers connected, signature aggregation might fail.")
	}

	// --- Signature Aggregator Setup ---
	sigAgg, err := aggregator.NewSignatureAggregator(
		network, // Pass the created network here
		logger,
		msgCreator,
		1024, // Default cache size
		sigAggMetrics.NewSignatureAggregatorMetrics(registry),
		pchainClient,
		pchainRPCOptions,
	)
	if err != nil {
		// Even though we don't store the network ref, try to shut it down on error
		network.Shutdown()
		return nil, fmt.Errorf("failed to create signature aggregator: %w", err)
	}

	return &AggregatorWrapper{
		sigAgg:          sigAgg,
		signingSubnetID: signingSubnetID,
	}, nil
}

// Sign uses the pre-configured aggregator to sign the message.
func (aw *AggregatorWrapper) Sign(ctx context.Context, unsignedMsg *avalancheWarp.UnsignedMessage) (*avalancheWarp.Message, error) {
	// Use a timeout specific to this aggregation call
	aggCtx, cancel := context.WithTimeout(ctx, defaultAppTimeout)
	defer cancel()

	// log.Printf("Calling CreateSignedMessage for Warp ID: %s", unsignedMsg.ID())
	signedMsg, err := aw.sigAgg.CreateSignedMessage(
		aggCtx,
		unsignedMsg,
		nil, // No justification
		aw.signingSubnetID,
		defaultRequiredQuorumPercentage,
		defaultQuorumPercentageBuffer,
	)
	if err != nil {
		return nil, fmt.Errorf("signature aggregation failed for msg %s: %w", unsignedMsg.ID(), err)
	}
	// log.Printf("Successfully aggregated signature for msg %s", unsignedMsg.ID())
	return signedMsg, nil
}

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
