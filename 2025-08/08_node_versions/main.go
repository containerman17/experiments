package main

import (
	"crypto/tls"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/ava-labs/avalanchego/genesis"
	"github.com/ava-labs/avalanchego/ids"
	"github.com/ava-labs/avalanchego/staking"
	"github.com/ava-labs/avalanchego/utils/constants"
	"github.com/ava-labs/avalanchego/utils/set"
)

func main() {
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
	subnet1, _ := ids.FromString("h7egyVb6fKHMDpVaEsTEcy7YaEnXrayxZS4A1AEU4pyBzmwGp")
	subnet2, _ := ids.FromString("nQCwF6V9y8VFjvMuPeQVWWYn6ba75518Dpf6ZMWZNb3NyTA94")
	subnet3, _ := ids.FromString("jmLmezoViv3F72XLzpdmSNk3qLEGb72g5EYkp3ij4wHXPF2KN")
	trackedSubnets := set.Set[ids.ID]{}
	trackedSubnets.Add(subnet1)
	trackedSubnets.Add(subnet2)
	trackedSubnets.Add(subnet3)

	fmt.Printf("🌐 Tracking subnets:\n")
	fmt.Printf("   - %s\n", subnet1)
	fmt.Printf("   - %s\n", subnet2)

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

	fmt.Println("\n🔄 Starting discovery loop...")
	fmt.Println("================================================\n")

	// Main loop
	for {
		// Get peer with oldest contact time
		peer := peerStore.GetOldestPeer()
		if peer == nil {
			fmt.Println("⚠️  No peers available")
			time.Sleep(10 * time.Second)
			continue
		}

		fmt.Printf("\n🔗 Connecting to %s (%s)\n", peer.NodeID, peer.IP)
		fmt.Printf("   Last contacted: %s\n", formatLastContacted(peer.LastContacted))

		// Update last contacted time immediately
		nodeID, _ := ids.NodeIDFromString(peer.NodeID)
		peerStore.UpdateLastContacted(nodeID)

		// Try to extract peers
		peerInfo, err := ExtractPeersFromPeer(peer.IP, tlsCert, network, trackedSubnets)
		if err != nil {
			fmt.Printf("  ❌ Failed: %v\n", err)
		} else {
			fmt.Printf("  ✅ Success! Version: %s\n", peerInfo.Version)

			// Update peer info
			peerStore.UpdatePeerInfo(peerInfo.NodeID, peerInfo.Version, peerInfo.TrackedSubnets)

			// Check if peer tracks our subnets
			tracksOurSubnets := false
			for _, subnet := range peerInfo.TrackedSubnets {
				if subnet == subnet1 || subnet == subnet2 {
					tracksOurSubnets = true
					break
				}
			}

			if tracksOurSubnets {
				// Filter out empty subnet for display
				displaySubnets := []ids.ID{}
				for _, subnet := range peerInfo.TrackedSubnets {
					if subnet != ids.Empty {
						displaySubnets = append(displaySubnets, subnet)
					}
				}
				fmt.Printf("  🎯 TRACKS OUR SUBNETS! Subnets: %v\n", displaySubnets)
			} else if len(peerInfo.TrackedSubnets) > 0 {
				// Count non-empty subnets
				nonEmptyCount := 0
				for _, subnet := range peerInfo.TrackedSubnets {
					if subnet != ids.Empty {
						nonEmptyCount++
					}
				}
				if nonEmptyCount > 0 {
					fmt.Printf("  🌐 Tracking %d subnet(s)\n", nonEmptyCount)
				}
			}

			fmt.Printf("  📍 Discovered %d new peers\n", len(peerInfo.NewPeerIPs))
		}

		// Save updated peer list
		if err := peerStore.Save(); err != nil {
			fmt.Printf("⚠️  Failed to save peer list: %v\n", err)
		}

		// Print stats
		fmt.Printf("\n📊 Total peers in database: %d\n", peerStore.PeerCount())
	}
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

func formatLastContacted(t time.Time) string {
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
