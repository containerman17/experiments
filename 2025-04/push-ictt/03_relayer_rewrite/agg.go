package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"log"
	"net/netip"
	"os"
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

	// Renamed to avoid conflict
	// Prometheus (for metrics boilerplate)
	"github.com/prometheus/client_golang/prometheus"
)

const (
	// Hardcoded local endpoints
	localNodeURL = "http://localhost:9650"

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
