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
		pathPattern: regexp.MustCompile(`^/v2/chains/([\w]+)/metrics/([a-zA-Z]+)$`),
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
	var chainIDInt *uint32
	switch chainID {
	case "total":
		// No filter, pass nil
		chainIDInt = nil
	case "mainnet":
		val := uint32(43114)
		chainIDInt = &val
	case "testnet":
		val := uint32(43113)
		chainIDInt = &val
	default:
		// Try parsing as numeric
		parsed, err := strconv.ParseUint(chainID, 10, 32)
		if err != nil {
			http.Error(w, "chainId must be either a numeric string, 'total', 'mainnet', or 'testnet'", http.StatusBadRequest)
			return
		}
		val := uint32(parsed)
		chainIDInt = &val
	}

	// Query ClickHouse for the metric data
	results, nextTimestamp, err := m.queryMetric(context.Background(), chainIDInt, metricName, timeInterval, paginationStart, endTimestamp, pageSize)
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
func (m *MetricsModule) queryMetric(ctx context.Context, chainID *uint32, metricName, timeInterval string, startTimestamp, endTimestamp int64, pageSize int) ([]MetricResult, int64, error) {
	startTime := time.Unix(startTimestamp, 0)
	endTime := time.Unix(endTimestamp, 0)

	// Determine time bucket function based on interval (use UTC timezone)
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

	// Build WHERE clause based on chainID
	var whereClause string
	var queryArgs []interface{}
	if chainID == nil {
		// No chain filter for "total"
		whereClause = "WHERE hour_bucket >= toDateTime(?, 'UTC') AND hour_bucket < toDateTime(?, 'UTC')"
		queryArgs = []interface{}{startTime, endTime, pageSize + 1}
	} else {
		// Filter by specific chain
		whereClause = "WHERE chain_id = ? AND hour_bucket >= toDateTime(?, 'UTC') AND hour_bucket < toDateTime(?, 'UTC')"
		queryArgs = []interface{}{*chainID, startTime, endTime, pageSize + 1}
	}

	// Build query - currently only supports activeAddresses and activeSenders
	// Other metrics can be added by querying the appropriate table/MV
	var query string
	if metricName == "activeAddresses" {
		query = fmt.Sprintf(`
			SELECT 
				toUnixTimestamp(%s(hour_bucket, 'UTC')) as timestamp,
				COUNT(DISTINCT address) as value
			FROM metrics_activeAddresses
			%s
			GROUP BY %s(hour_bucket, 'UTC')
			ORDER BY timestamp ASC
			LIMIT ?
		`, timeBucketFunc, whereClause, timeBucketFunc)
	} else if metricName == "activeSenders" {
		query = fmt.Sprintf(`
			SELECT 
				toUnixTimestamp(%s(hour_bucket, 'UTC')) as timestamp,
				COUNT(DISTINCT address) as value
			FROM metrics_activeSenders
			%s
			GROUP BY %s(hour_bucket, 'UTC')
			ORDER BY timestamp ASC
			LIMIT ?
		`, timeBucketFunc, whereClause, timeBucketFunc)
	} else if metricName == "txCount" {
		// Regular transaction count per time interval
		query = fmt.Sprintf(`
			SELECT 
				toUnixTimestamp(%s(hour_bucket, 'UTC')) as timestamp,
				toUInt64(SUM(tx_count)) as value
			FROM mv_metrics_txCount_hourly
			%s
			GROUP BY %s(hour_bucket, 'UTC')
			ORDER BY timestamp ASC
			LIMIT ?
		`, timeBucketFunc, whereClause, timeBucketFunc)
	} else if metricName == "cumulativeTxCount" {
		// Cumulative transaction count from genesis to (timestamp + 24h)
		// For each timestamp, counts ALL transactions from the beginning up to that point + 24h
		if chainID == nil {
			// For 'total', sum across all chains
			query = fmt.Sprintf(`
				WITH time_points AS (
					SELECT DISTINCT %s(hour_bucket, 'UTC') as time_bucket
					FROM mv_metrics_txCount_hourly
					WHERE hour_bucket >= toDateTime(?, 'UTC') 
						AND hour_bucket < toDateTime(?, 'UTC')
						AND %s(hour_bucket, 'UTC') >= toDateTime(?, 'UTC')
						AND %s(hour_bucket, 'UTC') < toDateTime(?, 'UTC')
					ORDER BY time_bucket
				)
				SELECT 
					toUnixTimestamp(t.time_bucket) as timestamp,
					toUInt64(SUM(m.tx_count)) as value
				FROM time_points t
				CROSS JOIN mv_metrics_txCount_hourly m
				WHERE m.hour_bucket < t.time_bucket + INTERVAL 1 DAY
				GROUP BY t.time_bucket
				ORDER BY timestamp ASC
				LIMIT ?
			`, timeBucketFunc, timeBucketFunc, timeBucketFunc)
			// Need to duplicate timestamps for the additional WHERE conditions
			if len(queryArgs) >= 3 {
				newArgs := []interface{}{queryArgs[0], queryArgs[1], queryArgs[0], queryArgs[1]}
				newArgs = append(newArgs, queryArgs[2:]...)
				queryArgs = newArgs
			}
		} else {
			// For specific chain - count all transactions from genesis to each point + 24h
			query = fmt.Sprintf(`
				WITH time_points AS (
					SELECT DISTINCT %s(hour_bucket, 'UTC') as time_bucket
					FROM mv_metrics_txCount_hourly
					WHERE chain_id = ?
						AND hour_bucket >= toDateTime(?, 'UTC') 
						AND hour_bucket < toDateTime(?, 'UTC')
						AND %s(hour_bucket, 'UTC') >= toDateTime(?, 'UTC')
						AND %s(hour_bucket, 'UTC') < toDateTime(?, 'UTC')
					ORDER BY time_bucket
				)
				SELECT 
					toUnixTimestamp(t.time_bucket) as timestamp,
					toUInt64(SUM(m.tx_count)) as value
				FROM time_points t
				CROSS JOIN mv_metrics_txCount_hourly m
				WHERE m.chain_id = ?
					AND m.hour_bucket < t.time_bucket + INTERVAL 1 DAY
				GROUP BY t.time_bucket
				ORDER BY timestamp ASC
				LIMIT ?
			`, timeBucketFunc, timeBucketFunc, timeBucketFunc)
			// Need to duplicate timestamps and chain_id for the additional WHERE conditions
			if len(queryArgs) >= 4 {
				// Original: chain_id, startTime, endTime, pageSize+1
				// New: chain_id, startTime, endTime, startTime, endTime, chain_id, pageSize+1
				newArgs := make([]interface{}, 0, len(queryArgs)+3)
				newArgs = append(newArgs, queryArgs[0], queryArgs[1], queryArgs[2], queryArgs[1], queryArgs[2], queryArgs[0])
				newArgs = append(newArgs, queryArgs[3:]...)
				queryArgs = newArgs
			}
		}
	} else {
		return nil, 0, fmt.Errorf("unsupported metric: %s", metricName)
	}

	rows, err := m.conn.Query(ctx, query, queryArgs...)
	if err != nil {
		return nil, 0, fmt.Errorf("query failed: %w", err)
	}
	defer rows.Close()

	results := make([]MetricResult, 0, pageSize)
	var lastTimestamp int64

	for rows.Next() {
		var timestamp uint32
		var value uint64

		if err := rows.Scan(&timestamp, &value); err != nil {
			return nil, 0, fmt.Errorf("scan failed: %w", err)
		}

		timestampInt64 := int64(timestamp)
		// Only add if we haven't exceeded pageSize
		if len(results) < pageSize {
			results = append(results, MetricResult{
				Value:     int(value),
				Timestamp: timestampInt64,
			})
		}
		lastTimestamp = timestampInt64
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
