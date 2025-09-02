package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"sync"
	"time"
)

// ValidatorResponse represents the API response format
type ValidatorResponse struct {
	NodeID         string   `json:"nodeId"`
	Version        string   `json:"version"`
	TrackedSubnets []string `json:"trackedSubnets"`
	LastAttempted  int64    `json:"lastAttempted"`
	LastSeenOnline int64    `json:"lastSeenOnline"`
}

// Global timer for idle shutdown
var (
	lastRequestTime time.Time
	lastRequestMu   sync.RWMutex
	idleTimeout     = 24 * time.Hour // Default, can be overridden
)

// StartAPI starts the HTTP API server on port 8080
func StartAPI(peerStore *PeerStore) {
	// Initialize last request time
	lastRequestMu.Lock()
	lastRequestTime = time.Now()
	lastRequestMu.Unlock()

	// Start idle shutdown monitor
	go monitorIdleShutdown()

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Update last request time
		lastRequestMu.Lock()
		lastRequestTime = time.Now()
		lastRequestMu.Unlock()

		handleValidators(w, r, peerStore)
	})

	fmt.Printf("🌐 API server starting on :8080 (auto-shutdown after %v idle)\n", idleTimeout)
	log.Fatal(http.ListenAndServe(":8080", nil))
}

func handleValidators(w http.ResponseWriter, r *http.Request, peerStore *PeerStore) {
	peerStore.mu.RLock()
	defer peerStore.mu.RUnlock()

	validators := make([]ValidatorResponse, 0, len(peerStore.peers))

	for _, peer := range peerStore.peers {
		// Convert timestamps to Unix seconds
		lastAttempted := int64(0)
		if !peer.LastAttempted.IsZero() {
			lastAttempted = peer.LastAttempted.Unix()
		}

		lastSeenOnline := int64(0)
		if !peer.LastSeenOnline.IsZero() {
			lastSeenOnline = peer.LastSeenOnline.Unix()
		}

		// Handle nil TrackedSubnets
		trackedSubnets := peer.TrackedSubnets
		if trackedSubnets == nil {
			trackedSubnets = []string{}
		}

		validator := ValidatorResponse{
			NodeID:         peer.NodeID,
			Version:        peer.Version,
			TrackedSubnets: trackedSubnets,
			LastAttempted:  lastAttempted,
			LastSeenOnline: lastSeenOnline,
		}

		validators = append(validators, validator)
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(validators); err != nil {
		http.Error(w, "Failed to encode response", http.StatusInternalServerError)
		return
	}
}

// monitorIdleShutdown watches for idle timeout and exits gracefully
func monitorIdleShutdown() {
	ticker := time.NewTicker(5 * time.Second) // Check every 5 seconds
	defer ticker.Stop()

	for range ticker.C {
		lastRequestMu.RLock()
		timeSinceLastRequest := time.Since(lastRequestTime)
		lastRequestMu.RUnlock()

		if timeSinceLastRequest > idleTimeout {
			fmt.Printf("\n💤 No API requests for %v, shutting down to save costs...\n", timeSinceLastRequest.Round(time.Second))
			os.Exit(0)
		}
	}
}
