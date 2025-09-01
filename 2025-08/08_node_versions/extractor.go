package main

import (
	"context"
	"crypto"
	"crypto/tls"
	"fmt"
	"net"
	"net/netip"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/ava-labs/avalanchego/ids"
	"github.com/ava-labs/avalanchego/message"
	"github.com/ava-labs/avalanchego/network/peer"
	"github.com/ava-labs/avalanchego/network/throttling"
	"github.com/ava-labs/avalanchego/proto/pb/p2p"
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
) (*ExtractedPeerInfo, error) {
	// Parse IP
	addr, err := netip.ParseAddrPort(peerIP)
	if err != nil {
		return nil, fmt.Errorf("invalid peer IP: %w", err)
	}

	// Clear any previously extracted IPs
	network.ClearExtractedIPs()

	// Create message handler to capture peer list
	var receivedPeerList bool
	msgHandler := router.InboundHandlerFunc(func(ctx context.Context, msg message.InboundMessage) {
		defer msg.OnFinishedHandling()

		switch msg.Op() {
		case message.PeerListOp:
			if pl, ok := msg.Message().(*p2p.PeerList); ok {
				receivedPeerList = true
				fmt.Printf("  📋 Received PeerList with %d peers\n", len(pl.ClaimedIpPorts))
			}
		}
	})

	// Connect to peer
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	p, err := connectToPeer(ctx, addr, tlsCert, network, msgHandler, trackedSubnets)
	if err != nil {
		return nil, err
	}
	defer func() {
		p.StartClose()
		p.AwaitClosed(context.Background())
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

	// Request peer list
	fmt.Println("  📮 Requesting peer list...")
	p.StartSendGetPeerList()

	// Wait for peer list response
	time.Sleep(5 * time.Second)

	if !receivedPeerList {
		fmt.Println("  ⚠️  No peer list received")
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
	// Connect to remote peer
	dialer := net.Dialer{}
	conn, err := dialer.DialContext(ctx, constants.NetworkType, remoteIP.String())
	if err != nil {
		return nil, fmt.Errorf("failed to connect: %w", err)
	}

	// Setup TLS
	tlsConfig := peer.TLSConfig(*tlsCert, nil)
	clientUpgrader := peer.NewTLSClientUpgrader(
		tlsConfig,
		prometheus.NewCounter(prometheus.CounterOpts{}),
	)

	peerID, conn, cert, err := clientUpgrader.Upgrade(conn)
	if err != nil {
		return nil, fmt.Errorf("TLS handshake failed: %w", err)
	}

	fmt.Printf("  🔐 TLS handshake successful with NodeID: %s\n", peerID)

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

	// Get our IP
	ourIP := getOutboundIP()
	if ourIP == netip.IPv4Unspecified() {
		ourIP = netip.MustParseAddr("54.95.191.28")
	}
	ourPort := uint16(9651)

	parsedCert, err := staking.ParseCertificate(tlsCert.Leaf.Raw)
	if err != nil {
		return nil, err
	}
	myNodeID := ids.NodeIDFromCert(parsedCert)

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
		Validators:           validators.NewManager(),
		NetworkID:            constants.MainnetID,
		PingFrequency:        constants.DefaultPingFrequency,
		PongTimeout:          constants.DefaultPingPongTimeout,
		MaxClockDifference:   time.Minute,
		ResourceTracker:      resourceTracker,
		UptimeCalculator:     uptime.NoOpCalculator,
		IPSigner: peer.NewIPSigner(
			utils.NewAtomic(netip.AddrPortFrom(ourIP, ourPort)),
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

	// Wait for peer to be ready
	if err := p.AwaitReady(ctx); err != nil {
		return nil, fmt.Errorf("peer failed to become ready: %w", err)
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
