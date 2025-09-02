package main

import (
	"crypto/tls"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/ava-labs/avalanchego/genesis"
	"github.com/ava-labs/avalanchego/ids"
	"github.com/ava-labs/avalanchego/staking"
	"github.com/ava-labs/avalanchego/utils/constants"
	"github.com/ava-labs/avalanchego/utils/set"
)

func main() {
	initializeOnly := false
	if len(os.Args) > 1 && os.Args[1] == "initialize_only" {
		initializeOnly = true
		fmt.Println("🚀 Initializing peer store...")
		fmt.Println("================================================")
	}

	fmt.Println("🚀 Starting one-by-one peer discovery...")
	fmt.Println("================================================")

	// Load or create TLS certificate
	tlsCert, err := loadOrCreateCertificate()
	if err != nil {
		fmt.Printf("❌ Failed to setup certificate: %v\n", err)
		return
	}

	// Print our NodeID
	parsedCert, err := staking.ParseCertificate(tlsCert.Leaf.Raw)
	if err != nil {
		fmt.Printf("❌ Failed to parse cert: %v\n", err)
		return
	}
	myNodeID := ids.NodeIDFromCert(parsedCert)
	fmt.Printf("🔑 Our NodeID: %s\n", myNodeID)

	// Setup tracked subnets
	subnet1, _ := ids.FromString("23dqTMHK186m4Rzcn1ukJdmHy13nqido4LjTp5Kh9W6qBKaFib")
	// subnet2, _ := ids.FromString("nQCwF6V9y8VFjvMuPeQVWWYn6ba75518Dpf6ZMWZNb3NyTA94")
	// subnet3, _ := ids.FromString("jmLmezoViv3F72XLzpdmSNk3qLEGb72g5EYkp3ij4wHXPF2KN")
	// subnet4, _ := ids.FromString("2qJPnDkDH6hn3PVzxzkUdTqDD1HeAnTT8FL4t2BJagc2iuq8j7")
	trackedSubnets := set.Set[ids.ID]{}
	trackedSubnets.Add(subnet1)
	// trackedSubnets.Add(subnet2)
	// trackedSubnets.Add(subnet3)
	// trackedSubnets.Add(subnet4)

	// Initialize peer store
	peerStore, err := NewPeerStore()
	if err != nil {
		fmt.Printf("❌ Failed to create peer store: %v\n", err)
		return
	}

	// If no peers exist, add bootstrap nodes
	if peerStore.PeerCount() == 0 {
		fmt.Println("📡 Loading bootstrap nodes...")
		bootstrappers := genesis.SampleBootstrappers(constants.MainnetID, 20)
		for _, b := range bootstrappers {
			peerStore.AddPeer(b.ID, b.IP, "", nil)
			fmt.Printf("  📍 Added bootstrap: %s\n", b.ID)
		}

		if err := peerStore.Save(); err != nil {
			fmt.Printf("⚠️  Failed to save initial peer list: %v\n", err)
		}
	}

	// Create network
	network := newDiscoveryNetwork(peerStore)

	// Start API server in background
	go StartAPI(peerStore)

	fmt.Println("\n🔄 Starting discovery loop...")
	fmt.Println("================================================\n")

	// Batch size for parallel processing
	batchSize := 400

	// Main loop
	for {

		minAge := 60 * time.Second
		if initializeOnly {
			minAge = 1000000 * time.Hour
		}
		// Get batch of peers with oldest contact time (older than 1 minute)
		peers := peerStore.GetOldestPeers(batchSize, minAge)
		if len(peers) == 0 {
			if initializeOnly {
				fmt.Println("🚀 Peer store initialized, exiting...")
				return
			}
			fmt.Println("⚠️  No peers available (or all contacted recently)")
			time.Sleep(10 * time.Second)
			continue
		}

		fmt.Printf("\n🔄 [%s] Processing batch of %d peers...\n",
			time.Now().Format("15:04:05"), len(peers))

		// Process peers in parallel
		processPeerBatch(peers, peerStore, tlsCert, network, trackedSubnets, initializeOnly)

		// Save updated peer list
		if err := peerStore.Save(); err != nil {
			fmt.Printf("⚠️  Failed to save peer list: %v\n", err)
		}
	}
}

func processPeerBatch(
	peers []*PeerInfo,
	peerStore *PeerStore,
	tlsCert *tls.Certificate,
	network *discoveryNetwork,
	trackedSubnets set.Set[ids.ID],
	initializeOnly bool,
) {
	var wg sync.WaitGroup
	wg.Add(len(peers))

	// Counters for summary
	var mu sync.Mutex
	var successCount, failCount, totalNewPeers int

	for _, peer := range peers {
		// Process each peer concurrently
		go func(p *PeerInfo) {
			defer wg.Done()

			// Create a separate network instance for this peer to avoid race conditions
			peerNetwork := newDiscoveryNetwork(peerStore)

			// Update last attempted time immediately
			nodeID, _ := ids.NodeIDFromString(p.NodeID)
			peerStore.UpdateLastAttempted(nodeID)

			// Try to extract peers

			waitSeconds := 20 * time.Second
			if initializeOnly {
				waitSeconds = 3 * time.Second
			}
			peerInfo, err := ExtractPeersFromPeer(p.IP, tlsCert, peerNetwork, trackedSubnets, waitSeconds)
			if err != nil {
				mu.Lock()
				failCount++
				mu.Unlock()
			} else {
				// Update peer info
				peerStore.UpdatePeerInfo(peerInfo.NodeID, peerInfo.Version, peerInfo.TrackedSubnets)

				mu.Lock()
				successCount++
				totalNewPeers += len(peerInfo.NewPeerIPs)
				mu.Unlock()
			}
		}(peer)
	}

	// Wait for all peers to be processed
	wg.Wait()

	// Print summary
	fmt.Printf("📊 Contacted %d/%d nodes (%d successful, %d failed), discovered %d new peers. Total peers: %d\n",
		successCount+failCount, len(peers), successCount, failCount, totalNewPeers, peerStore.PeerCount())
}

func loadOrCreateCertificate() (*tls.Certificate, error) {
	certPath := filepath.Join("/tmp", "avalanche_cert.pem")
	keyPath := filepath.Join("/tmp", "avalanche_key.pem")

	// Try to load existing certificate
	if _, err := os.Stat(certPath); err == nil {
		fmt.Println("📂 Loading existing certificate from /tmp/...")
		stakingCert, err := os.ReadFile(certPath)
		if err != nil {
			return nil, err
		}

		stakingKey, err := os.ReadFile(keyPath)
		if err != nil {
			return nil, err
		}

		tlsCert, err := staking.LoadTLSCertFromBytes(stakingCert, stakingKey)
		if err == nil {
			return tlsCert, nil
		}

		fmt.Printf("⚠️  Failed to load existing cert: %v\n", err)
	}

	// Create new certificate
	fmt.Println("🔐 Creating new certificate...")
	stakingKey, stakingCert, err := staking.NewCertAndKeyBytes()
	if err != nil {
		return nil, err
	}

	// Save for future use
	if err := os.WriteFile(certPath, stakingCert, 0600); err != nil {
		fmt.Printf("⚠️  Failed to save cert: %v\n", err)
	}
	if err := os.WriteFile(keyPath, stakingKey, 0600); err != nil {
		fmt.Printf("⚠️  Failed to save key: %v\n", err)
	}

	return staking.LoadTLSCertFromBytes(stakingCert, stakingKey)
}

func formatTimestamp(t time.Time) string {
	if t.IsZero() {
		return "Never"
	}

	duration := time.Since(t)
	if duration < time.Minute {
		return fmt.Sprintf("%.0f seconds ago", duration.Seconds())
	} else if duration < time.Hour {
		return fmt.Sprintf("%.0f minutes ago", duration.Minutes())
	} else if duration < 24*time.Hour {
		return fmt.Sprintf("%.1f hours ago", duration.Hours())
	}
	return fmt.Sprintf("%.1f days ago", duration.Hours()/24)
}
