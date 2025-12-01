package main

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"
)

const (
	prodURL  = "https://metrics.avax.network"
	localURL = "http://localhost:8080"
	chainID  = "16180"
	pageSize = 100
)

var valueMetrics = []string{
	"txCount", "gasUsed", "feesPaid", "avgTps", "maxTps",
	"avgGps", "maxGps", "avgGasPrice", "maxGasPrice",
	"contracts", "activeAddresses", "activeSenders", "deployers",
	"icmSent", "icmReceived", "icmTotal", "icmGasBurned",
}

var cumulativeMetrics = []string{
	"cumulativeTxCount", "cumulativeContracts",
	"cumulativeAddresses", "cumulativeDeployers",
}

var timeIntervals = []string{"hour", "day", "week", "month"}

// MetricResult with flexible Value parsing (can be string or number from prod)
type MetricResult struct {
	Value     json.RawMessage `json:"value"`
	Timestamp int64           `json:"timestamp"`
}

func (m MetricResult) ValueString() string {
	// Try to unmarshal as string first
	var s string
	if err := json.Unmarshal(m.Value, &s); err == nil {
		return s
	}
	// Otherwise return raw (it's a number)
	return string(m.Value)
}

type MetricResponse struct {
	Results []MetricResult `json:"results"`
}

// RollingResponse with flexible value types
type RollingResponse struct {
	Result map[string]json.RawMessage `json:"result"`
}

func (r RollingResponse) Get(key string) string {
	if v, ok := r.Result[key]; ok {
		var s string
		if err := json.Unmarshal(v, &s); err == nil {
			return s
		}
		return string(v)
	}
	return ""
}

type ComparisonResult struct {
	Metric       string
	Interval     string
	ProdCount    int
	LocalCount   int
	Matching     int
	Missing      int // in local but not in prod
	Extra        int // in prod but not in local
	DiffCount    int
	MedianDiff   float64
	AvgDiff      float64
	MaxDiff      float64
	MaxDiffTs    int64
	MaxDiffProd  string
	MaxDiffLocal string
}

func main() {
	client := &http.Client{Timeout: 30 * time.Second}

	var results []ComparisonResult

	fmt.Println("=== Comparing Metrics ===")
	fmt.Println()

	allMetrics := append(valueMetrics, cumulativeMetrics...)

	for _, metric := range allMetrics {
		for _, interval := range timeIntervals {
			// Skip hour for cumulative metrics
			if strings.HasPrefix(metric, "cumulative") && interval == "hour" {
				continue
			}

			result := compareMetric(client, metric, interval)
			results = append(results, result)

			status := "✓"
			if result.DiffCount > 0 || result.Missing > 0 || result.Extra > 0 {
				status = "✗"
			}
			if result.ProdCount == 0 && result.LocalCount == 0 {
				status = "·" // no data from either
			} else if result.ProdCount == 0 {
				status = "?" // no prod data
			}
			fmt.Printf("%s %s/%s: prod=%d local=%d match=%d diff=%d missing=%d extra=%d\n",
				status, metric, interval,
				result.ProdCount, result.LocalCount, result.Matching, result.DiffCount,
				result.Missing, result.Extra)
		}
	}

	fmt.Println()
	fmt.Println("=== Comparing Rolling Window Metrics ===")
	fmt.Println()

	for _, metric := range valueMetrics {
		compareRolling(client, metric)
	}

	// Summary of issues
	fmt.Println()
	fmt.Println("=== Summary of Differences ===")
	fmt.Println()

	var hasIssues bool
	for _, r := range results {
		if r.ProdCount == 0 {
			continue // skip metrics not in prod
		}
		if r.DiffCount > 0 || r.Missing > 0 || r.Extra > 0 {
			hasIssues = true
			fmt.Printf("%s/%s:\n", r.Metric, r.Interval)
			if r.Missing > 0 {
				fmt.Printf("  - %d periods missing in local\n", r.Missing)
			}
			if r.Extra > 0 {
				fmt.Printf("  - %d extra periods in local (not in prod)\n", r.Extra)
			}
			if r.DiffCount > 0 {
				fmt.Printf("  - %d periods with different values\n", r.DiffCount)
				fmt.Printf("    median diff: %.2f%%\n", r.MedianDiff)
				fmt.Printf("    avg diff: %.2f%%\n", r.AvgDiff)
				fmt.Printf("    max diff: %.2f%% at ts=%d\n", r.MaxDiff, r.MaxDiffTs)
				fmt.Printf("      prod:  %s\n", r.MaxDiffProd)
				fmt.Printf("      local: %s\n", r.MaxDiffLocal)
			}
			fmt.Println()
		}
	}

	if !hasIssues {
		fmt.Println("No differences found in metrics present in prod!")
	}
}

func compareMetric(client *http.Client, metric, interval string) ComparisonResult {
	result := ComparisonResult{
		Metric:   metric,
		Interval: interval,
	}

	prodData := fetchMetric(client, prodURL, metric, interval)
	localData := fetchMetric(client, localURL, metric, interval)

	result.ProdCount = len(prodData)
	result.LocalCount = len(localData)

	// Index by timestamp
	prodMap := make(map[int64]string)
	localMap := make(map[int64]string)
	for _, r := range prodData {
		prodMap[r.Timestamp] = r.ValueString()
	}
	for _, r := range localData {
		localMap[r.Timestamp] = r.ValueString()
	}

	var diffs []float64

	// Compare
	for ts, prodVal := range prodMap {
		localVal, exists := localMap[ts]
		if !exists {
			result.Missing++
			continue
		}
		if prodVal == localVal {
			result.Matching++
		} else {
			result.DiffCount++
			pctDiff := percentDiff(prodVal, localVal)
			diffs = append(diffs, pctDiff)
			if pctDiff > result.MaxDiff {
				result.MaxDiff = pctDiff
				result.MaxDiffTs = ts
				result.MaxDiffProd = prodVal
				result.MaxDiffLocal = localVal
			}
		}
	}

	// Check for extra in local
	for ts := range localMap {
		if _, exists := prodMap[ts]; !exists {
			result.Extra++
		}
	}

	// Compute stats
	if len(diffs) > 0 {
		sort.Float64s(diffs)
		result.MedianDiff = diffs[len(diffs)/2]
		var sum float64
		for _, d := range diffs {
			sum += d
		}
		result.AvgDiff = sum / float64(len(diffs))
	}

	return result
}

func fetchMetric(client *http.Client, baseURL, metric, interval string) []MetricResult {
	url := fmt.Sprintf("%s/v2/chains/%s/metrics/%s?pageSize=%d&timeInterval=%s",
		baseURL, chainID, metric, pageSize, interval)

	resp, err := client.Get(url)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error fetching %s: %v\n", url, err)
		return nil
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return nil
	}

	var data MetricResponse
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		fmt.Fprintf(os.Stderr, "Error decoding %s: %v\n", url, err)
		return nil
	}

	return data.Results
}

func compareRolling(client *http.Client, metric string) {
	prodData := fetchRolling(client, prodURL, metric)
	localData := fetchRolling(client, localURL, metric)

	if prodData == nil && localData == nil {
		fmt.Printf("· %s: no data from both\n", metric)
		return
	}
	if prodData == nil {
		fmt.Printf("? %s: no prod data\n", metric)
		return
	}
	if localData == nil {
		fmt.Printf("✗ %s: no local data\n", metric)
		return
	}

	fields := []string{"lastHour", "lastDay", "lastWeek", "lastMonth", "last90Days", "lastYear", "allTime"}

	var diffs []string
	for _, f := range fields {
		prod := prodData.Get(f)
		local := localData.Get(f)
		if prod != local {
			pct := percentDiff(prod, local)
			diffs = append(diffs, fmt.Sprintf("%s: %.1f%% (prod=%s local=%s)", f, pct, truncate(prod), truncate(local)))
		}
	}

	if len(diffs) == 0 {
		fmt.Printf("✓ %s: all match\n", metric)
	} else {
		fmt.Printf("✗ %s: %d differences\n", metric, len(diffs))
		for _, d := range diffs {
			fmt.Printf("    %s\n", d)
		}
	}
}

func fetchRolling(client *http.Client, baseURL, metric string) *RollingResponse {
	url := fmt.Sprintf("%s/v2/chains/%s/rollingWindowMetrics/%s", baseURL, chainID, metric)

	resp, err := client.Get(url)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return nil
	}

	var data RollingResponse
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return nil
	}

	return &data
}

func percentDiff(a, b string) float64 {
	// Parse as float for comparison (works for most values)
	var fa, fb float64
	fmt.Sscanf(a, "%f", &fa)
	fmt.Sscanf(b, "%f", &fb)

	if fa == 0 && fb == 0 {
		return 0
	}
	if fa == 0 {
		return 100.0
	}

	return math.Abs(fa-fb) / fa * 100
}

func truncate(s string) string {
	if len(s) > 20 {
		return s[:17] + "..."
	}
	return s
}
