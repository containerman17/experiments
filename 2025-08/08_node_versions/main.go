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
	// First check for AVA_NETWORK environment variable
	networkArg := os.Getenv("AVA_NETWORK")
	argIndex := 1

	// If no env var, parse network argument (fuji or mainnet)
	if networkArg == "" {
		if len(os.Args) < 2 {
			fmt.Println("❌ Usage: go run . <network> [initialize_only]")
			fmt.Println("   network must be: fuji or mainnet")
			fmt.Println("   Or set AVA_NETWORK environment variable")
			os.Exit(1)
		}
		networkArg = os.Args[1]
		argIndex = 2 // initialize_only will be at index 2 if network is from args
	}

	var networkID uint32
	var networkName string

	switch networkArg {
	case "fuji":
		networkID = constants.FujiID
		networkName = "fuji"
	case "mainnet":
		networkID = constants.MainnetID
		networkName = "mainnet"
	default:
		fmt.Printf("❌ Invalid network: %s\n", networkArg)
		fmt.Println("   network must be: fuji or mainnet")
		os.Exit(1)
	}

	initializeOnly := false
	if len(os.Args) > argIndex && os.Args[argIndex] == "initialize_only" {
		initializeOnly = true
		fmt.Println("🚀 Initializing peer store...")
		fmt.Println("================================================")
	}

	fmt.Printf("🚀 Starting one-by-one peer discovery for %s...\n", networkName)
	fmt.Println("================================================")

	// Load or create TLS certificate (network-specific)
	tlsCert, err := loadOrCreateCertificate(networkName)
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

	trackedSubnets := set.Set[ids.ID]{}
	// subnet1, _ := ids.FromString("23dqTMHK186m4Rzcn1ukJdmHy13nqido4LjTp5Kh9W6qBKaFib")
	// trackedSubnets.Add(subnet1)

	// Initialize peer store with network-specific file
	peerStore, err := NewPeerStore(networkName)
	if err != nil {
		fmt.Printf("❌ Failed to create peer store: %v\n", err)
		return
	}

	// If no peers exist, add bootstrap nodes
	if peerStore.PeerCount() == 0 {
		fmt.Println("📡 Loading bootstrap nodes...")
		bootstrappers := genesis.SampleBootstrappers(networkID, 30)
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
		processPeerBatch(peers, peerStore, tlsCert, network, trackedSubnets, initializeOnly, networkID)

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
	networkID uint32,
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

			waitDuration := 20 * time.Second
			if initializeOnly {
				waitDuration = 3 * time.Second
			}
			peerInfo, err := ExtractPeersFromPeer(p.IP, tlsCert, peerNetwork, trackedSubnets, waitDuration, networkID)
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

func loadOrCreateCertificate(networkName string) (*tls.Certificate, error) {
	certPath := filepath.Join("/tmp", fmt.Sprintf("avalanche_cert_%s.pem", networkName))
	keyPath := filepath.Join("/tmp", fmt.Sprintf("avalanche_key_%s.pem", networkName))

	// Try to load existing certificate
	if _, err := os.Stat(certPath); err == nil {
		fmt.Printf("📂 Loading existing certificate for %s from /tmp/...\n", networkName)
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
	fmt.Printf("🔐 Creating new certificate for %s...\n", networkName)
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
