package main

import (
	"encoding/json"
	"fmt"
	"net/netip"
	"os"
	"sync"
	"time"

	"github.com/ava-labs/avalanchego/ids"
	"github.com/ava-labs/avalanchego/utils/bloom"
)

const (
	peerListPath = "./peerlist.json"
	bloomSalt    = "discovery"
)

type PeerInfo struct {
	NodeID         string    `json:"nodeId"`
	IP             string    `json:"ip"`
	Version        string    `json:"version,omitempty"`
	TrackedSubnets []string  `json:"trackedSubnets,omitempty"`
	LastAttempted  time.Time `json:"lastAttempted"`  // When we last tried to contact
	LastSeenOnline time.Time `json:"lastSeenOnline"` // When we last successfully contacted
}

type PeerStore struct {
	mu          sync.RWMutex
	peers       map[string]*PeerInfo // key is NodeID string
	bloomFilter *bloom.Filter
}

func NewPeerStore() (*PeerStore, error) {
	store := &PeerStore{
		peers: make(map[string]*PeerInfo),
	}

	// Create bloom filter
	// For ~2k items with 3 hash functions: 2400 bytes gives ~1% false positive rate
	filter, err := bloom.New(3, 2400)
	if err != nil {
		return nil, fmt.Errorf("failed to create bloom filter: %w", err)
	}
	store.bloomFilter = filter

	// Load existing peers
	if err := store.Load(); err != nil {
		fmt.Printf("⚠️  No existing peer list found, starting fresh: %v\n", err)
	}

	return store, nil
}

func (ps *PeerStore) Load() error {
	data, err := os.ReadFile(peerListPath)
	if err != nil {
		return err
	}

	var peers []*PeerInfo
	if err := json.Unmarshal(data, &peers); err != nil {
		return fmt.Errorf("failed to unmarshal peers: %w", err)
	}

	ps.mu.Lock()
	defer ps.mu.Unlock()

	// Clear and rebuild
	ps.peers = make(map[string]*PeerInfo)
	ps.bloomFilter, err = bloom.New(3, 2400)
	if err != nil {
		return fmt.Errorf("failed to create bloom filter: %w", err)
	}

	for _, peer := range peers {
		ps.peers[peer.NodeID] = peer

		// Add to bloom filter
		nodeID, err := ids.NodeIDFromString(peer.NodeID)
		if err == nil {
			bloom.Add(ps.bloomFilter, nodeID[:], []byte(bloomSalt))
		}
	}

	fmt.Printf("📂 Loaded %d peers from disk\n", len(peers))
	return nil
}

func (ps *PeerStore) Save() error {
	ps.mu.RLock()
	defer ps.mu.RUnlock()

	peers := make([]*PeerInfo, 0, len(ps.peers))
	for _, peer := range ps.peers {
		peers = append(peers, peer)
	}

	data, err := json.MarshalIndent(peers, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal peers: %w", err)
	}

	if err := os.WriteFile(peerListPath, data, 0644); err != nil {
		return fmt.Errorf("failed to write peer list: %w", err)
	}

	return nil
}

func (ps *PeerStore) AddPeer(nodeID ids.NodeID, ip netip.AddrPort, version string, trackedSubnets []ids.ID) {
	ps.mu.Lock()
	defer ps.mu.Unlock()

	nodeIDStr := nodeID.String()

	// Convert subnet IDs to strings, filtering out empty (primary network) ID
	subnetStrs := []string{}
	for _, subnet := range trackedSubnets {
		if subnet != ids.Empty {
			subnetStrs = append(subnetStrs, subnet.String())
		}
	}

	// If no non-empty subnets, set to nil
	if len(subnetStrs) == 0 {
		subnetStrs = nil
	}

	peer := &PeerInfo{
		NodeID:         nodeIDStr,
		IP:             ip.String(),
		Version:        version,
		TrackedSubnets: subnetStrs,
		LastAttempted:  time.Time{}, // Zero time for new peers
		LastSeenOnline: time.Time{}, // Zero time for new peers
	}

	ps.peers[nodeIDStr] = peer
	bloom.Add(ps.bloomFilter, nodeID[:], []byte(bloomSalt))
}

func (ps *PeerStore) UpdateLastAttempted(nodeID ids.NodeID) {
	ps.mu.Lock()
	defer ps.mu.Unlock()

	if peer, exists := ps.peers[nodeID.String()]; exists {
		peer.LastAttempted = time.Now()
	}
}

func (ps *PeerStore) UpdatePeerInfo(nodeID ids.NodeID, version string, trackedSubnets []ids.ID) {
	ps.mu.Lock()
	defer ps.mu.Unlock()

	nodeIDStr := nodeID.String()
	if peer, exists := ps.peers[nodeIDStr]; exists {
		peer.Version = version
		peer.LastSeenOnline = time.Now()

		// Update tracked subnets, filtering out empty (primary network) ID
		subnetStrs := []string{}
		for _, subnet := range trackedSubnets {
			if subnet != ids.Empty {
				subnetStrs = append(subnetStrs, subnet.String())
			}
		}

		// If no non-empty subnets, set to nil
		if len(subnetStrs) == 0 {
			subnetStrs = nil
		}

		peer.TrackedSubnets = subnetStrs
	}
}

func (ps *PeerStore) GetOldestPeers(n int, olderThan time.Duration) []*PeerInfo {
	ps.mu.RLock()
	defer ps.mu.RUnlock()

	now := time.Now()
	cutoffTime := now.Add(-olderThan)

	// Convert map to slice and filter by olderThan
	eligiblePeers := make([]*PeerInfo, 0, len(ps.peers))
	for _, peer := range ps.peers {
		// Only include peers that haven't been attempted recently
		if peer.LastAttempted.Before(cutoffTime) {
			peerCopy := *peer
			eligiblePeers = append(eligiblePeers, &peerCopy)
		}
	}

	// Sort by LastAttempted (oldest first)
	for i := 0; i < len(eligiblePeers)-1; i++ {
		for j := i + 1; j < len(eligiblePeers); j++ {
			if eligiblePeers[j].LastAttempted.Before(eligiblePeers[i].LastAttempted) {
				eligiblePeers[i], eligiblePeers[j] = eligiblePeers[j], eligiblePeers[i]
			}
		}
	}

	// Return up to n peers
	if n > len(eligiblePeers) {
		n = len(eligiblePeers)
	}
	return eligiblePeers[:n]
}

func (ps *PeerStore) HasPeer(nodeID ids.NodeID) bool {
	ps.mu.RLock()
	defer ps.mu.RUnlock()

	_, exists := ps.peers[nodeID.String()]
	return exists
}

func (ps *PeerStore) GetBloomFilter() ([]byte, []byte) {
	ps.mu.RLock()
	defer ps.mu.RUnlock()

	return ps.bloomFilter.Marshal(), []byte(bloomSalt)
}

func (ps *PeerStore) PeerCount() int {
	ps.mu.RLock()
	defer ps.mu.RUnlock()

	return len(ps.peers)
}
