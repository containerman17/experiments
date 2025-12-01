package api

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"metrics-syncer/store"
	"metrics-syncer/syncer"
)

type Server struct {
	store   *store.Store
	router  *chi.Mux
	metrics []syncer.ValueMetric

	// Rolling window cache
	rwCache   map[string]*rollingWindowResult // key: chainID:metric
	rwCacheMu sync.RWMutex
	rwWmCache map[string]int64 // watermark cache to detect changes
}

type rollingWindowResult struct {
	LastHour   string `json:"lastHour"`
	LastDay    string `json:"lastDay"`
	LastWeek   string `json:"lastWeek"`
	LastMonth  string `json:"lastMonth"`
	Last90Days string `json:"last90Days"`
	LastYear   string `json:"lastYear"`
	AllTime    string `json:"allTime"`
}

func New(st *store.Store, metrics []syncer.ValueMetric) *Server {
	s := &Server{
		store:     st,
		metrics:   metrics,
		rwCache:   make(map[string]*rollingWindowResult),
		rwWmCache: make(map[string]int64),
	}
	s.setupRoutes()
	return s
}

func (s *Server) setupRoutes() {
	r := chi.NewRouter()
	// r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	r.Get("/v2/chains/{chainId}/metrics/{metricName}", s.handleGetMetric)
	r.Get("/v2/chains/{chainId}/rollingWindowMetrics/{metricName}", s.handleRollingWindowMetric)
	r.Get("/playground", s.handlePlayground)
	r.Get("/health", s.handleHealth)

	s.router = r
}

func (s *Server) Run(addr string) error {
	log.Printf("API server listening on %s", addr)
	return http.ListenAndServe(addr, s.router)
}

// MetricResult represents a single metric data point
type MetricResult struct {
	Value     string `json:"value"` // String for uint256 support
	Timestamp int64  `json:"timestamp"`
}

// MetricResponse is the API response format
type MetricResponse struct {
	Results       []MetricResult `json:"results"`
	NextPageToken string         `json:"nextPageToken,omitempty"`
}

// TotalChainID is the pseudo-chain ID for aggregated metrics across all chains
const TotalChainID uint32 = 0xFFFFFFFF // -1 as uint32

// parseChainID parses chainId - accepts "total" for total chain, returns 0xFFFFFFFE on error
func parseChainID(s string) uint32 {
	if s == "total" {
		return TotalChainID
	}
	id, err := strconv.ParseUint(s, 10, 32)
	if err != nil {
		return 0xFFFFFFFE // error sentinel (different from TotalChainID)
	}
	return uint32(id)
}

func (s *Server) handleGetMetric(w http.ResponseWriter, r *http.Request) {
	chainIDStr := chi.URLParam(r, "chainId")
	metricName := chi.URLParam(r, "metricName")

	chainID := parseChainID(chainIDStr)
	if chainID == 0xFFFFFFFE {
		http.Error(w, "invalid chainId", http.StatusBadRequest)
		return
	}

	// Parse query params
	startTs, _ := strconv.ParseInt(r.URL.Query().Get("startTimestamp"), 10, 64)
	endTs, _ := strconv.ParseInt(r.URL.Query().Get("endTimestamp"), 10, 64)
	timeInterval := r.URL.Query().Get("timeInterval")
	pageSizeStr := r.URL.Query().Get("pageSize")
	pageToken := r.URL.Query().Get("pageToken")

	// Defaults
	if timeInterval == "" {
		timeInterval = "day" // Default to day for safety
	}

	// Block hour granularity for cumulative metrics
	if strings.HasPrefix(metricName, "cumulative") && timeInterval == "hour" {
		http.Error(w, "hour granularity not supported for cumulative metrics", http.StatusBadRequest)
		return
	}

	pageSize := 100
	if pageSizeStr != "" {
		if ps, err := strconv.Atoi(pageSizeStr); err == nil && ps > 0 {
			pageSize = ps
		}
	}
	if pageSize > 1000 {
		pageSize = 1000
	}

	// Handle page token (it's a timestamp for continuation)
	if pageToken != "" {
		if ts, err := strconv.ParseInt(pageToken, 10, 64); err == nil {
			endTs = ts - 1 // Exclusive
		}
	}

	// Default time range if not specified
	if endTs == 0 {
		endTs = 9999999999 // Far future
	}

	// Query store
	points, nextTs := s.store.ScanMetrics(uint32(chainID), metricName, timeInterval, startTs, endTs, pageSize)

	// Convert to response format
	results := make([]MetricResult, len(points))
	for i, p := range points {
		results[i] = MetricResult{
			Value:     p.Value,
			Timestamp: p.Timestamp,
		}
	}

	resp := MetricResponse{Results: results}
	if nextTs > 0 {
		resp.NextPageToken = strconv.FormatInt(nextTs, 10)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func (s *Server) handleRollingWindowMetric(w http.ResponseWriter, r *http.Request) {
	chainIDStr := chi.URLParam(r, "chainId")
	metricName := chi.URLParam(r, "metricName")

	chainID := parseChainID(chainIDStr)
	if chainID == 0xFFFFFFFE {
		http.Error(w, "invalid chainId", http.StatusBadRequest)
		return
	}

	// Find metric and its aggregation type
	var agg string
	for _, m := range s.metrics {
		if m.Name == metricName {
			agg = m.RollingAgg
			break
		}
	}
	if agg == "" {
		http.Error(w, "metric not found or doesn't support rolling windows", http.StatusNotFound)
		return
	}

	// Check cache
	cacheKey := chainIDStr + ":" + metricName
	result := s.getRollingWindowCached(uint32(chainID), metricName, agg, cacheKey)
	if result == nil {
		http.Error(w, "no data available", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"result": result})
}

func (s *Server) getRollingWindowCached(chainID uint32, metric, agg, cacheKey string) *rollingWindowResult {
	// Check if watermark changed
	currentWm, hasWm := s.store.GetMaxWatermark(chainID, metric)
	if !hasWm {
		return nil
	}

	s.rwCacheMu.RLock()
	cachedWm := s.rwWmCache[cacheKey]
	cached := s.rwCache[cacheKey]
	s.rwCacheMu.RUnlock()

	if cached != nil && cachedWm == currentWm {
		return cached
	}

	// Recompute
	result := s.computeRollingWindow(chainID, metric, agg)
	if result == nil {
		return nil
	}

	s.rwCacheMu.Lock()
	s.rwCache[cacheKey] = result
	s.rwWmCache[cacheKey] = currentWm
	s.rwCacheMu.Unlock()

	return result
}

func (s *Server) computeRollingWindow(chainID uint32, metric, agg string) *rollingWindowResult {
	now := time.Now().UTC()

	// Define windows (relative to now)
	windows := []struct {
		name     string
		duration time.Duration
	}{
		{"lastHour", time.Hour},
		{"lastDay", 24 * time.Hour},
		{"lastWeek", 7 * 24 * time.Hour},
		{"lastMonth", 30 * 24 * time.Hour},
		{"last90Days", 90 * 24 * time.Hour},
		{"lastYear", 365 * 24 * time.Hour},
	}

	result := &rollingWindowResult{}

	for _, w := range windows {
		startTs := now.Add(-w.duration).Unix()
		endTs := now.Unix()
		val, _ := s.store.AggregateMetric(chainID, metric, agg, startTs, endTs)

		switch w.name {
		case "lastHour":
			result.LastHour = val
		case "lastDay":
			result.LastDay = val
		case "lastWeek":
			result.LastWeek = val
		case "lastMonth":
			result.LastMonth = val
		case "last90Days":
			result.Last90Days = val
		case "lastYear":
			result.LastYear = val
		}
	}

	// AllTime - use 0 as start
	allTime, _ := s.store.AggregateMetric(chainID, metric, agg, 0, now.Unix())
	result.AllTime = allTime

	return result
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("ok"))
}
