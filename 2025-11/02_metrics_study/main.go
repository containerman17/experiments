package main

import (
	"context"
	"log"
	"os"

	"github.com/joho/godotenv"

	"metrics-syncer/api"
	"metrics-syncer/clickhouse"
	"metrics-syncer/store"
	"metrics-syncer/syncer"
)

func main() {
	// Load .env if exists
	godotenv.Overload()

	// Config from env
	chHost := os.Getenv("CLICKHOUSE_HOST")
	chUser := os.Getenv("CLICKHOUSE_USER")
	chPassword := os.Getenv("CLICKHOUSE_PASSWORD")
	if chHost == "" || chUser == "" {
		log.Fatal("CLICKHOUSE_HOST and CLICKHOUSE_USER are required")
	}

	sqlitePath := os.Getenv("SQLITE_PATH")
	if sqlitePath == "" {
		sqlitePath = "data/metrics.db"
	}

	apiAddr := os.Getenv("API_ADDR")
	if apiAddr == "" {
		apiAddr = ":8080"
	}

	// Initialize store
	st := store.New(sqlitePath)
	defer st.Close()

	// Initialize ClickHouse client
	ch := clickhouse.New(chHost, chUser, chPassword)
	defer ch.Close()

	// Initialize syncer
	valueMetrics := syncer.AllValueMetrics()
	sync := syncer.New(ch, st)
	sync.RegisterValueMetrics(valueMetrics...)
	sync.RegisterCumulativeMetrics(syncer.AllCumulativeMetrics()...)

	// Initialize API server (pass metrics for rolling window aggregation info)
	apiServer := api.New(st, valueMetrics)

	// Start syncer in background
	go sync.Run(context.Background())

	// Run API server (blocks)
	if err := apiServer.Run(apiAddr); err != nil {
		log.Fatalf("API server error: %v", err)
	}
}
