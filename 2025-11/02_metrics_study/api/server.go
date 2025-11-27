package api

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"metrics-syncer/store"
)

type Server struct {
	store  *store.Store
	router *chi.Mux
}

func New(st *store.Store) *Server {
	s := &Server{store: st}
	s.setupRoutes()
	return s
}

func (s *Server) setupRoutes() {
	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	r.Get("/v2/chains/{chainId}/metrics/{metricName}", s.handleGetMetric)
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

func (s *Server) handleGetMetric(w http.ResponseWriter, r *http.Request) {
	chainIDStr := chi.URLParam(r, "chainId")
	metricName := chi.URLParam(r, "metricName")

	chainID, err := strconv.ParseUint(chainIDStr, 10, 32)
	if err != nil {
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
		timeInterval = "hour"
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
			Value:     p.Value, // Already string from store
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

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("ok"))
}
