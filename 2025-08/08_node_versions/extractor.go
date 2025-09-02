package main

import (
	"context"
	"crypto"
	"crypto/tls"
	"fmt"
	"net"
	"net/netip"
	"reflect"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/ava-labs/avalanchego/ids"
	"github.com/ava-labs/avalanchego/message"
	"github.com/ava-labs/avalanchego/network/peer"
	"github.com/ava-labs/avalanchego/network/throttling"
	"github.com/ava-labs/avalanchego/snow/networking/router"
	"github.com/ava-labs/avalanchego/snow/networking/tracker"
	"github.com/ava-labs/avalanchego/snow/uptime"
	"github.com/ava-labs/avalanchego/snow/validators"
	"github.com/ava-labs/avalanchego/staking"
	"github.com/ava-labs/avalanchego/upgrade"
	"github.com/ava-labs/avalanchego/utils"
	"github.com/ava-labs/avalanchego/utils/constants"
	"github.com/ava-labs/avalanchego/utils/crypto/bls/signer/localsigner"
	"github.com/ava-labs/avalanchego/utils/logging"
	"github.com/ava-labs/avalanchego/utils/math/meter"
	"github.com/ava-labs/avalanchego/utils/resource"
	"github.com/ava-labs/avalanchego/utils/set"
	"github.com/ava-labs/avalanchego/version"
)

type ExtractedPeerInfo struct {
	NodeID         ids.NodeID
	Version        string
	TrackedSubnets []ids.ID
	NewPeerIPs     []string
}

// ExtractPeersFromPeer connects to a peer, gets its version/subnets info, and extracts new peer IPs
func ExtractPeersFromPeer(
	peerIP string,
	tlsCert *tls.Certificate,
	network *discoveryNetwork,
	trackedSubnets set.Set[ids.ID],
	waitSeconds time.Duration,
) (*ExtractedPeerInfo, error) {
	// Parse IP
	addr, err := netip.ParseAddrPort(peerIP)
	if err != nil {
		return nil, fmt.Errorf("invalid peer IP: %w", err)
	}

	// Clear any previously extracted IPs
	network.ClearExtractedIPs()

	// Create message handler to capture peer list
	msgHandler := router.InboundHandlerFunc(func(ctx context.Context, msg message.InboundMessage) {
		defer msg.OnFinishedHandling()

		switch msg.Op() {
		case message.PeerListOp:
			// Peer list received - no action needed for summary mode
		}
	})

	// Overall timeout for entire operation - generous for busy nodes
	ctx, cancel := context.WithTimeout(context.Background(), waitSeconds)
	defer cancel()

	p, err := connectToPeer(ctx, addr, tlsCert, network, msgHandler, trackedSubnets)
	if err != nil {
		return nil, err
	}
	defer func() {
		if p != nil {
			p.StartClose()
			// Don't wait long for cleanup
			closeCtx, closeCancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer closeCancel()
			_ = p.AwaitClosed(closeCtx)
		}
	}()

	// Extract peer info
	peerInfo := &ExtractedPeerInfo{
		NodeID:  p.ID(),
		Version: p.Version().String(),
	}

	// Get tracked subnets
	trackedSubnetSet := p.TrackedSubnets()
	peerInfo.TrackedSubnets = make([]ids.ID, 0, trackedSubnetSet.Len())
	for subnet := range trackedSubnetSet {
		peerInfo.TrackedSubnets = append(peerInfo.TrackedSubnets, subnet)
	}

	// Request peer list with AllSubnets=true to get ALL peers, not just subnet-matching ones
	if err := sendGetPeerListAllSubnets(p, network); err != nil {
		// Failed to send GetPeerList - continue anyway, peer might still Track new peers
	}

	// Wait for peer list response - use remaining context time minus a small buffer for cleanup
	deadline, ok := ctx.Deadline()
	if ok {
		waitTime := time.Until(deadline) - 2*time.Second // Leave 2s for cleanup
		if waitTime > 0 {
			time.Sleep(waitTime)
		}
	}

	// Get extracted IPs from network
	peerInfo.NewPeerIPs = network.GetExtractedIPs()

	return peerInfo, nil
}

func connectToPeer(
	ctx context.Context,
	remoteIP netip.AddrPort,
	tlsCert *tls.Certificate,
	network peer.Network,
	msgHandler router.InboundHandler,
	trackedSubnets set.Set[ids.ID],
) (peer.Peer, error) {
	// Connect to remote peer using context timeout
	conn, err := (&net.Dialer{}).DialContext(ctx, constants.NetworkType, remoteIP.String())
	if err != nil {
		return nil, fmt.Errorf("TCP connection failed: %w", err)
	}

	// Setup TLS
	tlsConfig := peer.TLSConfig(*tlsCert, nil)
	clientUpgrader := peer.NewTLSClientUpgrader(
		tlsConfig,
		prometheus.NewCounter(prometheus.CounterOpts{}),
	)

	// Store original connection in case Upgrade fails
	origConn := conn
	peerID, conn, cert, err := clientUpgrader.Upgrade(origConn)
	if err != nil {
		// Close original connection if upgrade failed
		if origConn != nil {
			_ = origConn.Close()
		}
		return nil, fmt.Errorf("TLS handshake failed: %w", err)
	}

	// Check if upgraded connection is valid
	if conn == nil {
		if origConn != nil {
			_ = origConn.Close()
		}
		return nil, fmt.Errorf("TLS upgrade returned nil connection")
	}

	// TLS handshake successful

	// Create message creator
	mc, err := message.NewCreator(
		prometheus.NewRegistry(),
		constants.DefaultNetworkCompressionType,
		10*time.Second,
	)
	if err != nil {
		return nil, err
	}

	// Create metrics
	metrics, err := peer.NewMetrics(prometheus.NewRegistry())
	if err != nil {
		return nil, err
	}

	// Create resource tracker
	resourceTracker, err := tracker.NewResourceTracker(
		prometheus.NewRegistry(),
		resource.NoUsage,
		meter.ContinuousFactory{},
		10*time.Second,
	)
	if err != nil {
		return nil, err
	}

	// Setup keys
	tlsKey := tlsCert.PrivateKey.(crypto.Signer)
	blsKey, err := localsigner.New()
	if err != nil {
		return nil, err
	}

	parsedCert, err := staking.ParseCertificate(tlsCert.Leaf.Raw)
	if err != nil {
		return nil, err
	}
	myNodeID := ids.NodeIDFromCert(parsedCert)

	// Create validator manager that pretends we're a validator
	// This makes other nodes send us unfiltered peer lists
	fakeValidators := validators.NewManager()
	fakeValidators.AddStaker(constants.PrimaryNetworkID, myNodeID, nil, ids.Empty, 1)

	// Create peer configuration
	config := &peer.Config{
		Metrics:              metrics,
		MessageCreator:       mc,
		Log:                  logging.NoLog{},
		InboundMsgThrottler:  throttling.NewNoInboundThrottler(),
		Network:              network,
		Router:               msgHandler,
		VersionCompatibility: version.GetCompatibility(upgrade.InitiallyActiveTime),
		MyNodeID:             myNodeID,
		MySubnets:            trackedSubnets,
		Beacons:              validators.NewManager(),
		Validators:           fakeValidators, // Pretend we're a validator
		NetworkID:            constants.MainnetID,
		PingFrequency:        constants.DefaultPingFrequency,
		PongTimeout:          constants.DefaultPingPongTimeout,
		MaxClockDifference:   10 * time.Second,
		ResourceTracker:      resourceTracker,
		UptimeCalculator:     uptime.NoOpCalculator,
		IPSigner: peer.NewIPSigner(
			utils.NewAtomic(netip.AddrPortFrom(getOutboundIP(), 9651)),
			tlsKey,
			blsKey,
		),
	}

	// Create and start peer
	p := peer.Start(
		config,
		conn,
		cert,
		peerID,
		peer.NewBlockingMessageQueue(
			metrics,
			logging.NoLog{},
			1024,
		),
		false,
	)

	// Wait for peer to be ready - use the parent context timeout
	if err := p.AwaitReady(ctx); err != nil {
		if p != nil {
			p.StartClose()
		}
		return nil, fmt.Errorf("peer not ready: %w", err)
	}

	return p, nil
}

func getOutboundIP() netip.Addr {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		return netip.IPv4Unspecified()
	}
	defer conn.Close()

	localAddr := conn.LocalAddr().(*net.UDPAddr)
	if addr, ok := netip.AddrFromSlice(localAddr.IP); ok {
		return addr
	}
	return netip.IPv4Unspecified()
}

// sendGetPeerListAllSubnets sends a GetPeerList message with AllSubnets=true
// to request ALL peers, not just those matching our tracked subnets
func sendGetPeerListAllSubnets(p peer.Peer, network peer.Network) error {
	// Get known peers bloom filter
	knownPeersFilter, knownPeersSalt := network.KnownPeers()

	// Get the peer's config through reflection (since we need MessageCreator)
	// This is a bit hacky but necessary since peer.Config is embedded
	peerVal := reflect.ValueOf(p).Elem()
	configField := peerVal.FieldByName("Config")
	if !configField.IsValid() {
		return fmt.Errorf("couldn't access peer Config")
	}

	config := configField.Interface().(*peer.Config)

	// Create GetPeerList message with AllSubnets=true
	msg, err := config.MessageCreator.GetPeerList(
		knownPeersFilter,
		knownPeersSalt,
		true, // AllSubnets=true to get ALL peers
	)
	if err != nil {
		return fmt.Errorf("failed to create GetPeerList message: %w", err)
	}

	// Send the message
	sendCtx, sendCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer sendCancel()

	if !p.Send(sendCtx, msg) {
		return fmt.Errorf("failed to send GetPeerList message")
	}

	return nil
}
