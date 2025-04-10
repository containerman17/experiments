package main

import (
	"context"
	"crypto/tls"
	"encoding/hex"
	"flag"
	"fmt"
	"log"
	"net/netip"
	"os"
	"strings"
	"time"

	// AvalancheGo
	"github.com/ava-labs/avalanchego/api/info"
	"github.com/ava-labs/avalanchego/ids"
	"github.com/ava-labs/avalanchego/message"
	"github.com/ava-labs/avalanchego/network/peer"
	"github.com/ava-labs/avalanchego/utils/constants"
	"github.com/ava-labs/avalanchego/utils/logging"
	"github.com/ava-labs/avalanchego/utils/set"
	"github.com/ava-labs/avalanchego/vms/platformvm"
	avalancheWarp "github.com/ava-labs/avalanchego/vms/platformvm/warp"

	// ICM Services
	basecfg "github.com/ava-labs/icm-services/config"
	"github.com/ava-labs/icm-services/peers"
	peerUtils "github.com/ava-labs/icm-services/peers/utils"
	"github.com/ava-labs/icm-services/signature-aggregator/aggregator"
	sigAggMetrics "github.com/ava-labs/icm-services/signature-aggregator/metrics"
	saTypes "github.com/ava-labs/icm-services/types" // Renamed to avoid conflict

	// Prometheus (for metrics boilerplate)
	"github.com/prometheus/client_golang/prometheus"
)

const (
	// Hardcoded local endpoints
	localNodeURL  = "http://localhost:9650"
	infoAPIPath   = "/ext/info"
	pchainAPIPath = "/ext/bc/P"

	// Default quorum values for the example
	defaultRequiredQuorumPercentage = 67
	defaultQuorumPercentageBuffer   = 3
	defaultAppTimeout               = 15 * time.Second // Generous timeout for local test
	defaultConnectTimeout           = 10 * time.Second
)

// --- Minimal Config Implementation for Peers ---
// This struct satisfies the peers.Config interface just enough for this example.
type minimalPeerConfig struct {
	infoAPI   *basecfg.APIConfig
	pchainAPI *basecfg.APIConfig
}

func (m *minimalPeerConfig) GetInfoAPI() *basecfg.APIConfig     { return m.infoAPI }
func (m *minimalPeerConfig) GetPChainAPI() *basecfg.APIConfig   { return m.pchainAPI }
func (m *minimalPeerConfig) GetAllowPrivateIPs() bool           { return true }                  // Allow local connection
func (m *minimalPeerConfig) GetTrackedSubnets() set.Set[ids.ID] { return set.NewSet[ids.ID](1) } // Minimal
func (m *minimalPeerConfig) GetTLSCert() *tls.Certificate       { return nil }                   // No TLS for local example

// --- Main Aggregation Logic ---

func aggregateSignature(
	ctx context.Context,
	unsignedMsg *avalancheWarp.UnsignedMessage,
	signingSubnetID ids.ID,
) (*avalancheWarp.Message, error) {

	// --- Basic Setup ---
	logLevel := logging.Info

	logger := logging.NewLogger(
		"aggregator-example",
		logging.NewWrappedCore(logLevel, os.Stdout, logging.JSON.ConsoleEncoder()),
	)
	networkLogger := logging.NewLogger(
		"p2p-network-example",
		logging.NewWrappedCore(logLevel, os.Stdout, logging.JSON.ConsoleEncoder()),
	)

	// --- API Clients ---
	log.Println("Creating info client with URL:", localNodeURL)
	infoClient := info.NewClient(localNodeURL)
	pchainClient := platformvm.NewClient(localNodeURL)
	pchainRPCOptions := peerUtils.InitializeOptions(&basecfg.APIConfig{}) // No extra opts needed for local

	// --- Get Local Node Info (for manual tracking) ---
	localNodeID, _, err := infoClient.GetNodeID(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get local node ID: %w", err)
	}
	localNodeIP, err := infoClient.GetNodeIP(ctx)
	if err != nil {
		// Try parsing common default if GetNodeIP fails (it might not be configured)
		log.Printf("WARN: Failed to get node IP via API (%v), attempting default 127.0.0.1:9651", err)
		localNodeIP, err = netip.ParseAddrPort("127.0.0.1:9651") // Common default staking port
		if err != nil {
			return nil, fmt.Errorf("failed to get/parse local node IP: %w", err)
		}
	}
	log.Printf("Attempting to use local node: ID=%s, IP=%s", localNodeID, localNodeIP)

	// --- Minimal Peer Network Setup ---
	peerCfg := &minimalPeerConfig{
		infoAPI:   &basecfg.APIConfig{BaseURL: localNodeURL},
		pchainAPI: &basecfg.APIConfig{BaseURL: localNodeURL},
	}

	// Registerer for metrics (can be dummy for example)
	registry := prometheus.NewRegistry()

	trackedSubnets := set.NewSet[ids.ID](1)
	trackedSubnets.Add(signingSubnetID)
	// We will track the specific subnet later via network.TrackSubnet

	manuallyTrackedPeers := []info.Peer{
		{Info: peer.Info{ID: localNodeID, PublicIP: localNodeIP}},
	}

	// Message Creator
	msgCreator, err := message.NewCreator(
		logger,   // Use the main logger
		registry, // Can use a dummy registry
		constants.DefaultNetworkCompressionType,
		constants.DefaultNetworkMaximumInboundTimeout,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create message creator: %w", err)
	}

	fmt.Printf("using peerCfg: %+v\n", peerCfg)
	network, err := peers.NewNetwork(
		networkLogger,
		registry, // Use the same registry
		trackedSubnets,
		manuallyTrackedPeers,
		peerCfg, // Use our minimal config impl
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create app request network: %w", err)
	}
	defer network.Shutdown()

	// Explicitly track the signing subnet
	log.Printf("Tracking signing subnet: %s", signingSubnetID)
	network.TrackSubnet(signingSubnetID)

	// Allow some time for the network to potentially connect to the manual peer
	log.Printf("Waiting briefly for network connection...")
	time.Sleep(3 * time.Second) // Give it a moment
	log.Printf("Number of connected peers: %d", network.NumConnectedPeers())
	if network.NumConnectedPeers() == 0 {
		log.Println("WARN: No peers connected, signature aggregation might fail.")
	}

	// --- Signature Aggregator Setup ---
	sigAgg, err := aggregator.NewSignatureAggregator(
		network,
		logger,
		msgCreator,
		1024, // Default cache size
		sigAggMetrics.NewSignatureAggregatorMetrics(registry),
		pchainClient,
		pchainRPCOptions,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create signature aggregator: %w", err)
	}

	// --- Perform Aggregation ---
	log.Printf("Calling CreateSignedMessage for Warp ID: %s, Signing Subnet: %s", unsignedMsg.ID(), signingSubnetID)
	aggCtx, cancel := context.WithTimeout(ctx, defaultAppTimeout) // Context for the aggregation call itself
	defer cancel()

	signedMsg, err := sigAgg.CreateSignedMessage(
		aggCtx,
		unsignedMsg,
		nil, // No justification in this simple example
		signingSubnetID,
		defaultRequiredQuorumPercentage,
		defaultQuorumPercentageBuffer,
	)
	if err != nil {
		return nil, fmt.Errorf("signature aggregation failed: %w", err)
	}

	log.Println("Successfully aggregated signatures.")
	return signedMsg, nil
}

// --- Main Execution ---

func main() {
	// --- Command Line Flags ---
	unsignedMsgHex := flag.String("unsigned-msg-hex",
		"0x00000000000532f28c97836382882d7ab3839516affdb55587dc9eb06d7d5cdf1566eee0af4f000001c200000000000100000014253b2784c75e510dd0ff1da844684a1ac0aa5fcf000001a000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000369000000000000000000000000789a5fdac2b37fcd290fb2924382297a6ae65860297706a9d583e56aaea89f408c006fd1c8807ce9d2387fa0b0cb801af6cf066200000000000000000000000017ab05351fc94a1a67bf3f56ddbb941ae6c63e2500000000000000000000000000000000000000000000000000000000000186a00000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000012000000000000000000000000000000000000000000000000000000000000001400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000369",
		"Hex-encoded UnsignedMessage bytes")
	signingSubnetStr := flag.String("signing-subnet", "2eob8mVishyekgALVg3g85NDWXHRQ1unYbBrj355MogAd9sUnb", "Subnet ID (CB58) whose validators should sign")
	timeoutSec := flag.Uint("timeout", 30, "Overall timeout in seconds for the operation")

	flag.Parse()

	if *unsignedMsgHex == "" {
		fmt.Println("Error: -unsigned-msg-hex flag is required.")
		fmt.Println("  Provide the raw hex data of an avalanchego/vms/platformvm/warp.UnsignedMessage")
		fmt.Println("  (Hint: Get this from the 'Raw Data' log line in the previous script's error output, or construct manually)")
		flag.Usage()
		os.Exit(1)
	}
	if *signingSubnetStr == "" {
		fmt.Println("Error: -signing-subnet flag cannot be empty.")
		flag.Usage()
		os.Exit(1)
	}

	// --- Decode Inputs ---
	unsignedMsgBytes, err := hex.DecodeString(strings.TrimPrefix(*unsignedMsgHex, "0x"))
	if err != nil {
		log.Fatalf("Failed to decode unsigned message hex: %v", err)
	}

	// Use the standalone parser from avalanchego for the raw bytes provided
	unsignedMsg, err := avalancheWarp.ParseUnsignedMessage(unsignedMsgBytes)
	if err != nil {
		// Also try the types helper just in case the input was from a log's Data field
		unsignedMsg, err = saTypes.UnpackWarpMessage(unsignedMsgBytes) // Use the helper from types
		if err != nil {
			log.Fatalf("Failed to parse unsigned message bytes (tried both standalone and log unpacker): %v", err)
		}
	}

	signingSubnetID, err := ids.FromString(*signingSubnetStr)
	if err != nil {
		log.Fatalf("Failed to parse signing subnet ID '%s': %v", *signingSubnetStr, err)
	}

	// --- Context for Overall Operation ---
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(*timeoutSec)*time.Second)
	defer cancel()

	// --- Run Aggregation ---
	signedMsg, err := aggregateSignature(ctx, unsignedMsg, signingSubnetID)
	if err != nil {
		log.Fatalf("Error aggregating signature: %v", err)
	}

	// --- Print Result ---
	fmt.Println("\n--- Aggregation Successful ---")
	fmt.Printf("Original Unsigned Message ID: %s\n", unsignedMsg.ID())
	fmt.Printf("Signed Message ID:            %s\n", signedMsg.ID())
	fmt.Printf("Signed Message Bytes (Hex):   0x%s\n", hex.EncodeToString(signedMsg.Bytes()))
	// You could further parse the signature part if needed:
	// fmt.Printf("Signature Signers (Hex):    0x%s\n", hex.EncodeToString(signedMsg.Signature.Signers))
	// fmt.Printf("Signature Sig (Hex):        0x%s\n", hex.EncodeToString(signedMsg.Signature.Signature[:]))

	log.Println("Finished.")
}
