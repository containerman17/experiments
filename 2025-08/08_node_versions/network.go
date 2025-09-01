package main

import (
	"fmt"
	"sync"

	"github.com/ava-labs/avalanchego/ids"
	"github.com/ava-labs/avalanchego/utils/bloom"
	"github.com/ava-labs/avalanchego/utils/ips"
	"github.com/ava-labs/avalanchego/utils/set"
)

type discoveryNetwork struct {
	mu           sync.RWMutex
	peerStore    *PeerStore
	extractedIPs []string // IPs extracted from the last peer connection
}

func newDiscoveryNetwork(peerStore *PeerStore) *discoveryNetwork {
	return &discoveryNetwork{
		peerStore:    peerStore,
		extractedIPs: make([]string, 0),
	}
}

func (n *discoveryNetwork) Connected(peerID ids.NodeID) {
	fmt.Printf("  ✅ Network: Connected to %s\n", peerID)
}

func (n *discoveryNetwork) AllowConnection(peerID ids.NodeID) bool {
	return true
}

func (n *discoveryNetwork) Track(peers []*ips.ClaimedIPPort) error {
	n.mu.Lock()
	defer n.mu.Unlock()

	newPeers := 0
	for _, peer := range peers {
		nodeID := ids.NodeIDFromCert(peer.Cert)
		if !n.peerStore.HasPeer(nodeID) {
			n.peerStore.AddPeer(nodeID, peer.AddrPort, "", nil)
			n.extractedIPs = append(n.extractedIPs, peer.AddrPort.String())
			newPeers++
		}
	}

	if newPeers > 0 {
		fmt.Printf("  📍 Network: Tracked %d new peers\n", newPeers)
	}

	return nil
}

func (n *discoveryNetwork) Disconnected(peerID ids.NodeID) {
	fmt.Printf("  ❌ Network: Disconnected from %s\n", peerID)
}

func (n *discoveryNetwork) KnownPeers() ([]byte, []byte) {
	return n.peerStore.GetBloomFilter()
}

func (n *discoveryNetwork) Peers(
	peerID ids.NodeID,
	trackedSubnets set.Set[ids.ID],
	requestAllPeers bool,
	knownPeers *bloom.ReadFilter,
	peerSalt []byte,
) []*ips.ClaimedIPPort {
	// We don't serve peers in discovery mode
	return []*ips.ClaimedIPPort{}
}

func (n *discoveryNetwork) GetExtractedIPs() []string {
	n.mu.RLock()
	defer n.mu.RUnlock()

	// Return a copy
	ips := make([]string, len(n.extractedIPs))
	copy(ips, n.extractedIPs)
	return ips
}

func (n *discoveryNetwork) ClearExtractedIPs() {
	n.mu.Lock()
	defer n.mu.Unlock()

	n.extractedIPs = n.extractedIPs[:0]
}
