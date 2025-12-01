package syncer

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
)

// Granularity represents time granularity
type Granularity string

const (
	Hour  Granularity = "hour"
	Day   Granularity = "day"
	Week  Granularity = "week"
	Month Granularity = "month"
)

var AllGranularities = []Granularity{Hour, Day, Week, Month}

// CumulativeGranularities - cumulative metrics skip hour (too expensive)
var CumulativeGranularities = []Granularity{Day, Week, Month}

// TotalChainID is the pseudo-chain ID for aggregated metrics across all chains
const TotalChainID uint32 = 0xFFFFFFFF // -1 as uint32

// ValueMetric defines a metric that returns a single value per period (incremental)
type ValueMetric struct {
	Name       string // API name (camelCase)
	Query      string // ClickHouse query with placeholders
	Version    string // Optional version - if empty, uses hash of Query
	RollingAgg string // "sum", "max", "avg", "" = not in rolling windows
}

// CumulativeMetric defines a metric that requires full table scan (e.g., unique counts)
// These skip hourly granularity because they're expensive
type CumulativeMetric struct {
	Name    string // API name (camelCase), e.g., "cumulativeAddresses"
	Query   string // ClickHouse query - does full scan, returns only periods >= watermark
	Version string // Optional version - if empty, uses hash of Query
}

// getVersion returns explicit version or hash of query
func getVersion(version, query string) string {
	if version != "" {
		return version
	}
	h := sha256.Sum256([]byte(query))
	return hex.EncodeToString(h[:8]) // 16 char hex
}

// chainStr returns a readable string for chain ID (e.g., "total" or "43114")
func chainStr(chainID uint32) string {
	if chainID == TotalChainID {
		return "total"
	}
	return fmt.Sprintf("%d", chainID)
}
