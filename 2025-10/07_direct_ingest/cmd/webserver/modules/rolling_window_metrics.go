package modules

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strconv"

	"clickhouse-metrics-poc/pkg/chwrapper"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// RollingWindowMetricsModule handles rolling window metrics API endpoints
type RollingWindowMetricsModule struct {
	conn        driver.Conn
	pathPattern *regexp.Regexp
}

// NewRollingWindowMetricsModule creates a new rolling window metrics module
func NewRollingWindowMetricsModule() (*RollingWindowMetricsModule, error) {
	conn, err := chwrapper.Connect()
	if err != nil {
		return nil, fmt.Errorf("failed to connect to ClickHouse: %w", err)
	}
	return &RollingWindowMetricsModule{
		conn:        conn,
		pathPattern: regexp.MustCompile(`^/v2/chains/([\w]+)/rollingWindowMetrics/([a-zA-Z]+)$`),
	}, nil
}

// RollingWindowResponse represents the response format
type RollingWindowResponse struct {
	Result struct {
		LastHour   int `json:"lastHour"`
		LastDay    int `json:"lastDay"`
		LastWeek   int `json:"lastWeek"`
		LastMonth  int `json:"lastMonth"`
		Last90Days int `json:"last90Days"`
		LastYear   int `json:"lastYear"`
		AllTime    int `json:"allTime"`
	} `json:"result"`
}

// Handler handles rolling window metrics API requests
func (m *RollingWindowMetricsModule) Handler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	matches := m.pathPattern.FindStringSubmatch(r.URL.Path)
	if matches == nil {
		http.NotFound(w, r)
		return
	}

	chainID := matches[1]
	metricName := matches[2]

	if metricName != "maxTps" {
		http.Error(w, fmt.Sprintf("Unknown metric: %s", metricName), http.StatusBadRequest)
		return
	}

	// Parse chain ID
	var chainIDInt uint32
	switch chainID {
	case "mainnet":
		chainIDInt = 43114
	case "testnet":
		chainIDInt = 43113
	case "total":
		// For total, we'll query all chains and get max
		m.handleTotal(w, r)
		return
	default:
		parsed, err := strconv.ParseUint(chainID, 10, 32)
		if err != nil {
			http.Error(w, "Invalid chainId", http.StatusBadRequest)
			return
		}
		chainIDInt = uint32(parsed)
	}

	// Single query to precomputed table
	query := `
		SELECT last_hour, last_day, last_week, last_month, 
		       last_90_days, last_year, all_time
		FROM rollingWindowMetrics_maxTps_precomputed
		WHERE chain_id = ?
		ORDER BY computed_at DESC
		LIMIT 1
	`

	var response RollingWindowResponse
	row := m.conn.QueryRow(context.Background(), query, chainIDInt)
	err := row.Scan(
		&response.Result.LastHour,
		&response.Result.LastDay,
		&response.Result.LastWeek,
		&response.Result.LastMonth,
		&response.Result.Last90Days,
		&response.Result.LastYear,
		&response.Result.AllTime,
	)
	if err != nil {
		log.Printf("Error querying maxTps for chain %s: %v", chainID, err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// handleTotal handles the "total" case - max across all chains
func (m *RollingWindowMetricsModule) handleTotal(w http.ResponseWriter, r *http.Request) {
	query := `
		SELECT 
			MAX(last_hour), MAX(last_day), MAX(last_week), MAX(last_month),
			MAX(last_90_days), MAX(last_year), MAX(all_time)
		FROM (
			SELECT * FROM rollingWindowMetrics_maxTps_precomputed
			ORDER BY chain_id, computed_at DESC
			LIMIT 1 BY chain_id
		)
	`

	var response RollingWindowResponse
	row := m.conn.QueryRow(context.Background(), query)
	err := row.Scan(
		&response.Result.LastHour,
		&response.Result.LastDay,
		&response.Result.LastWeek,
		&response.Result.LastMonth,
		&response.Result.Last90Days,
		&response.Result.LastYear,
		&response.Result.AllTime,
	)
	if err != nil {
		log.Printf("Error querying total maxTps: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// Close closes the ClickHouse connection
func (m *RollingWindowMetricsModule) Close() error {
	if m.conn != nil {
		return m.conn.Close()
	}
	return nil
}
