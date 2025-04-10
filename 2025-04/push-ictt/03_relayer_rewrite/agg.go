package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"log"
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

	// Prometheus (for metrics boilerplate)
	"github.com/prometheus/client_golang/prometheus"
)

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
	logLevel := logging.Info // Or configure as needed
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

	// Allow some time for the network to potentially connect
	log.Printf("Waiting briefly for network connection...")
	time.Sleep(3 * time.Second)
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

	log.Printf("Calling CreateSignedMessage for Warp ID: %s", unsignedMsg.ID())
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
	log.Printf("Successfully aggregated signature for msg %s", unsignedMsg.ID())
	return signedMsg, nil
}

// Note: Shutdown method removed as the network reference is no longer stored.
// The network's lifecycle is implicitly managed by the SignatureAggregator.
