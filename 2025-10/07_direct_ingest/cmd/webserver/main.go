package main

import (
	"log"
	"net/http"

	"clickhouse-metrics-poc/cmd/webserver/modules"
)

func main() {
	// Create metrics module
	metricsModule, err := modules.NewMetricsModule()
	if err != nil {
		log.Fatalf("Failed to create metrics module: %v", err)
	}

	// Create rolling window metrics module
	rollingWindowModule, err := modules.NewRollingWindowMetricsModule()
	if err != nil {
		log.Fatalf("Failed to create rolling window metrics module: %v", err)
	}

	// Combined handler that routes to appropriate module
	http.HandleFunc("/v2/chains/", func(w http.ResponseWriter, r *http.Request) {
		// Try rolling window metrics first (more specific path)
		if rollingWindowModule.PathMatches(r.URL.Path) {
			rollingWindowModule.Handler(w, r)
			return
		}
		// Fall back to regular metrics
		metricsModule.Handler(w, r)
	})

	// Start server
	port := ":8080"
	log.Printf("Starting server on %s", port)
	log.Printf("Example: curl 'http://localhost:8080/v2/chains/43114/metrics/activeAddresses?pageSize=5&timeInterval=hour&startTimestamp=1612966290&endTimestamp=1613009490'")

	if err := http.ListenAndServe(port, nil); err != nil {
		log.Fatal(err)
	}
}
