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
	IP             string   `json:"ip"`
}

// Cache for API responses
type APICache struct {
	data      []byte
	timestamp time.Time
	mu        sync.RWMutex
}

// Global timer for idle shutdown and response cache
var (
	lastRequestTime time.Time
	lastRequestMu   sync.RWMutex
	idleTimeout     = 24 * time.Hour // Default, can be overridden
	responseCache   = &APICache{}
	cacheDuration   = 10 * time.Second
)

// StartAPI starts the HTTP API server on port 8080
func StartAPI(peerStore *PeerStore) {
	// Initialize last request time
	lastRequestMu.Lock()
	lastRequestTime = time.Now()
	lastRequestMu.Unlock()

	// Start idle shutdown monitor
	go monitorIdleShutdown()

	// Create a handler with CORS middleware
	handler := corsMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Update last request time
		lastRequestMu.Lock()
		lastRequestTime = time.Now()
		lastRequestMu.Unlock()

		handleValidators(w, r, peerStore)
	}))

	http.Handle("/", handler)

	fmt.Printf("🌐 API server starting on :8080 with CORS enabled (auto-shutdown after %v idle)\n", idleTimeout)
	log.Fatal(http.ListenAndServe(":8080", nil))
}

// corsMiddleware adds CORS headers to allow all origins, methods and headers
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Set CORS headers - WARNING: This allows EVERYTHING
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "*")
		w.Header().Set("Access-Control-Allow-Headers", "*")
		w.Header().Set("Access-Control-Max-Age", "86400") // 24 hours
		
		// Handle preflight OPTIONS request
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		
		next.ServeHTTP(w, r)
	})
}

func handleValidators(w http.ResponseWriter, r *http.Request, peerStore *PeerStore) {
	// Check cache first
	responseCache.mu.RLock()
	if time.Since(responseCache.timestamp) < cacheDuration && len(responseCache.data) > 0 {
		// Cache hit - return cached response
		cachedData := responseCache.data
		responseCache.mu.RUnlock()

		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "public, max-age=10")
		w.Write(cachedData)
		return
	}
	responseCache.mu.RUnlock()

	// Cache miss - generate fresh response
	responseCache.mu.Lock()
	defer responseCache.mu.Unlock()

	// Double-check cache after acquiring write lock (another goroutine might have updated it)
	if time.Since(responseCache.timestamp) < cacheDuration && len(responseCache.data) > 0 {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "public, max-age=10")
		w.Write(responseCache.data)
		return
	}

	// Generate fresh response
	peerStore.mu.RLock()
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
			LastAttempted:  lastAttempted * 1000,
			LastSeenOnline: lastSeenOnline * 1000,
			IP:             peer.IP,
		}

		validators = append(validators, validator)
	}
	peerStore.mu.RUnlock()

	// Marshal response
	responseData, err := json.Marshal(validators)
	if err != nil {
		http.Error(w, "Failed to encode response", http.StatusInternalServerError)
		return
	}

	// Update cache
	responseCache.data = responseData
	responseCache.timestamp = time.Now()

	// Send response with cache headers
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=10")
	w.Write(responseData)
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
