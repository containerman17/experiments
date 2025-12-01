package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"sort"
	"time"
)

var (
	baseURL    = flag.String("url", "http://localhost:8080", "API base URL")
	numReqs    = flag.Int("n", 100, "number of requests")
	concurrent = flag.Int("c", 1, "concurrent requests")
)

var chainIDs = []string{"43114", "2786", "8198", "10507", "16180", "total"}
var metrics = []string{"txCount", "gasUsed", "feesPaid", "avgTps", "maxTps", "activeAddresses", "contracts"}
var intervals = []string{"hour", "day", "week", "month"}

func main() {
	flag.Parse()
	rand.Seed(time.Now().UnixNano())

	fmt.Printf("Benchmarking %s with %d requests (%d concurrent)\n\n", *baseURL, *numReqs, *concurrent)

	// Benchmark metrics endpoint
	fmt.Println("=== /v2/chains/{chainId}/metrics/{metricName} ===")
	benchMetrics()

	fmt.Println()

	// Benchmark rolling window endpoint
	fmt.Println("=== /v2/chains/{chainId}/rollingWindowMetrics/{metricName} ===")
	benchRollingWindow()
}

func benchMetrics() {
	results := make(chan time.Duration, *numReqs)
	errors := make(chan error, *numReqs)

	sem := make(chan struct{}, *concurrent)
	start := time.Now()

	for i := 0; i < *numReqs; i++ {
		sem <- struct{}{}
		go func() {
			defer func() { <-sem }()

			chain := chainIDs[rand.Intn(len(chainIDs))]
			metric := metrics[rand.Intn(len(metrics))]
			interval := intervals[rand.Intn(len(intervals))]

			// Random time range in last 2 years
			now := time.Now().Unix()
			twoYearsAgo := now - 2*365*24*3600
			end := twoYearsAgo + rand.Int63n(now-twoYearsAgo)
			start := end - rand.Int63n(30*24*3600) // up to 30 days range

			url := fmt.Sprintf("%s/v2/chains/%s/metrics/%s?startTimestamp=%d&endTimestamp=%d&timeInterval=%s&pageSize=100",
				*baseURL, chain, metric, start, end, interval)

			startTime := time.Now()
			resp, err := http.Get(url)
			elapsed := time.Since(startTime)

			if err != nil {
				errors <- err
				return
			}
			defer resp.Body.Close()
			io.ReadAll(resp.Body)

			if resp.StatusCode != 200 {
				errors <- fmt.Errorf("status %d for %s", resp.StatusCode, url)
				return
			}

			results <- elapsed
		}()
	}

	// Wait for all
	for i := 0; i < *concurrent; i++ {
		sem <- struct{}{}
	}
	elapsed := time.Since(start)
	close(results)
	close(errors)

	printStats(results, errors, elapsed)
}

func benchRollingWindow() {
	results := make(chan time.Duration, *numReqs)
	errors := make(chan error, *numReqs)

	sem := make(chan struct{}, *concurrent)
	start := time.Now()

	for i := 0; i < *numReqs; i++ {
		sem <- struct{}{}
		go func() {
			defer func() { <-sem }()

			chain := chainIDs[rand.Intn(len(chainIDs))]
			metric := metrics[rand.Intn(len(metrics))]

			url := fmt.Sprintf("%s/v2/chains/%s/rollingWindowMetrics/%s", *baseURL, chain, metric)

			startTime := time.Now()
			resp, err := http.Get(url)
			elapsed := time.Since(startTime)

			if err != nil {
				errors <- err
				return
			}
			defer resp.Body.Close()
			body, _ := io.ReadAll(resp.Body)

			if resp.StatusCode != 200 {
				errors <- fmt.Errorf("status %d: %s", resp.StatusCode, string(body))
				return
			}

			// Parse to verify it's valid JSON
			var result map[string]interface{}
			if err := json.Unmarshal(body, &result); err != nil {
				errors <- fmt.Errorf("invalid json: %v", err)
				return
			}

			results <- elapsed
		}()
	}

	// Wait for all
	for i := 0; i < *concurrent; i++ {
		sem <- struct{}{}
	}
	elapsed := time.Since(start)
	close(results)
	close(errors)

	printStats(results, errors, elapsed)
}

func printStats(results chan time.Duration, errors chan error, totalElapsed time.Duration) {
	var latencies []time.Duration
	for d := range results {
		latencies = append(latencies, d)
	}

	var errs []error
	for e := range errors {
		errs = append(errs, e)
	}

	if len(latencies) == 0 {
		fmt.Println("No successful requests!")
		for _, e := range errs {
			fmt.Printf("  Error: %v\n", e)
		}
		return
	}

	sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })

	var total time.Duration
	for _, d := range latencies {
		total += d
	}

	throughput := float64(len(latencies)) / totalElapsed.Seconds()
	fmt.Printf("Requests:  %d ok, %d errors in %v (%.0f req/s)\n", len(latencies), len(errs), totalElapsed.Round(time.Millisecond), throughput)
	fmt.Printf("Latency:   min=%v, max=%v, avg=%v\n",
		latencies[0],
		latencies[len(latencies)-1],
		total/time.Duration(len(latencies)))
	fmt.Printf("Percentiles: p50=%v, p90=%v, p99=%v\n",
		latencies[len(latencies)*50/100],
		latencies[len(latencies)*90/100],
		latencies[len(latencies)*99/100])

	if len(errs) > 0 && len(errs) <= 5 {
		fmt.Println("Errors:")
		for _, e := range errs {
			fmt.Printf("  %v\n", e)
		}
	}
}

