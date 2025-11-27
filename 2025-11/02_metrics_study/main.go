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

	pebblePath := os.Getenv("PEBBLE_PATH")
	if pebblePath == "" {
		pebblePath = "data/pebble"
	}

	apiAddr := os.Getenv("API_ADDR")
	if apiAddr == "" {
		apiAddr = ":8080"
	}

	// Initialize store
	st := store.New(pebblePath)
	defer st.Close()

	// Initialize ClickHouse client
	ch := clickhouse.New(chHost, chUser, chPassword)
	defer ch.Close()

	// Initialize syncer
	sync := syncer.New(ch, st)
	sync.RegisterValueMetrics(syncer.AllValueMetrics()...)
	sync.RegisterEntityMetrics(syncer.AllEntityMetrics()...)

	// Initialize API server
	apiServer := api.New(st)

	// Start syncer in background
	go sync.Run(context.Background())

	// Run API server (blocks)
	if err := apiServer.Run(apiAddr); err != nil {
		log.Fatalf("API server error: %v", err)
	}
}
