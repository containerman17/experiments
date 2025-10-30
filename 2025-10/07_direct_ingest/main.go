package main

import (
	"clickhouse-metrics-poc/pkg/ingest/cache"
	"clickhouse-metrics-poc/pkg/ingest/chwrapper"
	"clickhouse-metrics-poc/pkg/ingest/syncer"
	"log"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	// Configuration
	chainID := uint32(43114) // Avalanche C-Chain
	rpcURL := "http://localhost:9650/ext/bc/C/rpc"

	// Create cache
	cache, err := cache.New("./data", chainID)
	if err != nil {
		log.Fatalf("Failed to create cache: %v", err)
	}
	defer cache.Close()

	// Connect to ClickHouse
	conn, err := chwrapper.Connect()
	if err != nil {
		log.Fatalf("Failed to connect to ClickHouse: %v", err)
	}
	defer conn.Close()

	err = chwrapper.CreateTables(conn)
	if err != nil {
		log.Fatalf("Failed to create tables: %v", err)
	}

	// Create and configure syncer
	chainSyncer, err := syncer.NewChainSyncer(syncer.Config{
		ChainID:          chainID,
		RpcURL:           rpcURL,
		RpcConcurrency:   300,
		DebugConcurrency: 100,
		CHConn:           conn,
		Cache:            cache,
		FetchBatchSize:   500,
	})
	if err != nil {
		log.Fatalf("Failed to create syncer: %v", err)
	}

	// Start syncing
	if err := chainSyncer.Start(); err != nil {
		log.Fatalf("Failed to start syncer: %v", err)
	}

	// Setup signal handling for graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-sigChan
		log.Println("Received shutdown signal, stopping gracefully...")
		chainSyncer.Stop()
	}()

	// Wait for syncer to complete or be stopped
	chainSyncer.Wait()

	log.Println("Sync completed")
}
