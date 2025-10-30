package modules

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"clickhouse-metrics-poc/pkg/chwrapper"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// MetricsModule handles metrics API endpoints
type MetricsModule struct {
	conn        driver.Conn
	pathPattern *regexp.Regexp
}

// NewMetricsModule creates a new metrics module
func NewMetricsModule() (*MetricsModule, error) {
	conn, err := chwrapper.Connect()
	if err != nil {
		return nil, fmt.Errorf("failed to connect to ClickHouse: %w", err)
	}
	return &MetricsModule{
		conn:        conn,
		pathPattern: regexp.MustCompile(`^/v2/chains/(\d+)/metrics/([a-zA-Z]+)$`),
	}, nil
}

// Handler handles metrics API requests
func (m *MetricsModule) Handler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Check if path matches our pattern
	matches := m.pathPattern.FindStringSubmatch(r.URL.Path)
	if matches == nil {
		http.NotFound(w, r)
		return
	}

	chainID := matches[1]
	metricName := matches[2]

	// Parse query parameters
	query := r.URL.Query()

	startTimestamp, err := strconv.ParseInt(query.Get("startTimestamp"), 10, 64)
	if err != nil && query.Get("startTimestamp") != "" {
		http.Error(w, "Invalid startTimestamp", http.StatusBadRequest)
		return
	}

	endTimestamp, err := strconv.ParseInt(query.Get("endTimestamp"), 10, 64)
	if err != nil && query.Get("endTimestamp") != "" {
		http.Error(w, "Invalid endTimestamp", http.StatusBadRequest)
		return
	}

	// Default timestamps if not provided
	if startTimestamp == 0 {
		startTimestamp = time.Now().Add(-24 * time.Hour).Unix()
	}
	if endTimestamp == 0 {
		endTimestamp = time.Now().Unix()
	}

	pageSize := 100 // default
	if ps := query.Get("pageSize"); ps != "" {
		pageSizeInt, err := strconv.Atoi(ps)
		if err != nil || pageSizeInt < 1 || pageSizeInt > 2160 {
			http.Error(w, "Invalid pageSize (must be 1-2160)", http.StatusBadRequest)
			return
		}
		pageSize = pageSizeInt
	}

	timeInterval := query.Get("timeInterval")
	if timeInterval == "" {
		timeInterval = "hour"
	}

	// Validate time interval
	validIntervals := map[string]bool{"hour": true, "day": true, "week": true, "month": true}
	if !validIntervals[timeInterval] {
		http.Error(w, "Invalid timeInterval (must be hour, day, week, or month)", http.StatusBadRequest)
		return
	}

	// Handle pagination token (timestamp-based)
	var paginationStart int64
	if pageToken := query.Get("pageToken"); pageToken != "" {
		paginationStart, err = strconv.ParseInt(pageToken, 10, 64)
		if err != nil {
			http.Error(w, "Invalid pageToken", http.StatusBadRequest)
			return
		}
	} else {
		paginationStart = startTimestamp
	}

	// Parse chain ID
	chainIDInt, err := strconv.ParseUint(chainID, 10, 32)
	if err != nil {
		http.Error(w, "Invalid chainId", http.StatusBadRequest)
		return
	}

	// Query ClickHouse for the metric data
	results, nextTimestamp, err := m.queryMetric(context.Background(), uint32(chainIDInt), metricName, timeInterval, paginationStart, endTimestamp, pageSize)
	if err != nil {
		log.Printf("Error querying metric: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	// Prepare response
	response := MetricsResponse{
		Results: results,
	}

	// Add nextPageToken if there's more data
	if nextTimestamp > 0 && nextTimestamp <= endTimestamp && len(results) == pageSize {
		response.NextPageToken = strconv.FormatInt(nextTimestamp, 10)
	}

	// Log the request
	log.Printf("Metrics request: chain=%s, metric=%s, interval=%s, pageSize=%d, results=%d",
		chainID, metricName, timeInterval, pageSize, len(results))

	// Send response
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding response: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
	}
}

// MetricsResponse represents the standard response format for all metrics
type MetricsResponse struct {
	Results       []MetricResult `json:"results"`
	NextPageToken string         `json:"nextPageToken,omitempty"`
}

// MetricResult represents a single metric data point
type MetricResult struct {
	Value     int   `json:"value"`
	Timestamp int64 `json:"timestamp"`
}

// queryMetric queries ClickHouse for metric data
func (m *MetricsModule) queryMetric(ctx context.Context, chainID uint32, metricName, timeInterval string, startTimestamp, endTimestamp int64, pageSize int) ([]MetricResult, int64, error) {
	startTime := time.Unix(startTimestamp, 0)
	endTime := time.Unix(endTimestamp, 0)

	// Determine time bucket function based on interval
	var timeBucketFunc string
	switch timeInterval {
	case "hour":
		timeBucketFunc = "toStartOfHour"
	case "day":
		timeBucketFunc = "toStartOfDay"
	case "week":
		timeBucketFunc = "toStartOfWeek"
	case "month":
		timeBucketFunc = "toStartOfMonth"
	default:
		return nil, 0, fmt.Errorf("unsupported timeInterval: %s", timeInterval)
	}

	// Build query - currently only supports activeAddresses
	// Other metrics can be added by querying the appropriate table/MV
	var query string
	if metricName == "activeAddresses" {
		query = fmt.Sprintf(`
			SELECT 
				toUnixTimestamp(%s(hour_bucket)) as timestamp,
				COUNT(DISTINCT address) as value
			FROM metrics_activeAddresses
			WHERE chain_id = ? 
				AND hour_bucket >= toDateTime(?) 
				AND hour_bucket < toDateTime(?)
			GROUP BY %s(hour_bucket)
			ORDER BY timestamp ASC
			LIMIT ?
		`, timeBucketFunc, timeBucketFunc)
	} else {
		return nil, 0, fmt.Errorf("unsupported metric: %s", metricName)
	}

	rows, err := m.conn.Query(ctx, query, chainID, startTime, endTime, pageSize+1)
	if err != nil {
		return nil, 0, fmt.Errorf("query failed: %w", err)
	}
	defer rows.Close()

	results := make([]MetricResult, 0, pageSize)
	var lastTimestamp int64

	for rows.Next() {
		var timestamp int64
		var value uint64

		if err := rows.Scan(&timestamp, &value); err != nil {
			return nil, 0, fmt.Errorf("scan failed: %w", err)
		}

		// Only add if we haven't exceeded pageSize
		if len(results) < pageSize {
			results = append(results, MetricResult{
				Value:     int(value),
				Timestamp: timestamp,
			})
		}
		lastTimestamp = timestamp
	}

	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("rows error: %w", err)
	}

	// Calculate next timestamp for pagination
	var nextTimestamp int64
	if len(results) == pageSize && lastTimestamp > 0 {
		// Calculate next bucket start based on interval
		lastTime := time.Unix(lastTimestamp, 0)
		var nextTime time.Time
		switch timeInterval {
		case "hour":
			nextTime = lastTime.Add(1 * time.Hour)
		case "day":
			nextTime = lastTime.Add(24 * time.Hour)
		case "week":
			nextTime = lastTime.Add(7 * 24 * time.Hour)
		case "month":
			// Approximate month as 30 days
			nextTime = lastTime.Add(30 * 24 * time.Hour)
		}
		nextTimestamp = nextTime.Unix()
	}

	return results, nextTimestamp, nil
}

// Close closes the ClickHouse connection
func (m *MetricsModule) Close() error {
	if m.conn != nil {
		return m.conn.Close()
	}
	return nil
}
