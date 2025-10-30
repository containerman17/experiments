package main

import (
	"clickhouse-metrics-poc/pkg/chwrapper"
	"clickhouse-metrics-poc/pkg/ingest/cache"
	"clickhouse-metrics-poc/pkg/ingest/syncer"
	"encoding/json"
	"log"
	"os"
	"os/signal"
	"sync"
	"syscall"
)

type ChainConfig struct {
	ChainID        uint32 `json:"chainID"`
	RpcURL         string `json:"rpcURL"`
	MaxConcurrency int    `json:"maxConcurrency,omitempty"`
	FetchBatchSize int    `json:"fetchBatchSize,omitempty"`
}

func main() {
	// Load configuration
	configData, err := os.ReadFile("config.json")
	if err != nil {
		log.Fatalf("Failed to read config.json: %v", err)
	}

	var configs []ChainConfig
	if err := json.Unmarshal(configData, &configs); err != nil {
		log.Fatalf("Failed to parse config.json: %v", err)
	}

	if len(configs) == 0 {
		log.Fatal("No chain configurations found in config.json")
	}

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

	// Setup signal handling for graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	var wg sync.WaitGroup
	syncers := make([]*syncer.ChainSyncer, 0, len(configs))

	// Start a syncer for each chain
	for _, cfg := range configs {
		// Create cache
		cache, err := cache.New("./data", cfg.ChainID)
		if err != nil {
			log.Fatalf("Failed to create cache for chain %d: %v", cfg.ChainID, err)
		}
		defer cache.Close()

		// Create syncer
		chainSyncer, err := syncer.NewChainSyncer(syncer.Config{
			ChainID:        cfg.ChainID,
			RpcURL:         cfg.RpcURL,
			MaxConcurrency: cfg.MaxConcurrency,
			CHConn:         conn,
			Cache:          cache,
			FetchBatchSize: cfg.FetchBatchSize,
		})
		if err != nil {
			log.Fatalf("Failed to create syncer for chain %d: %v", cfg.ChainID, err)
		}

		syncers = append(syncers, chainSyncer)

		wg.Add(1)
		go func(cs *syncer.ChainSyncer, chainID uint32) {
			defer wg.Done()
			if err := cs.Start(); err != nil {
				log.Printf("Failed to start syncer for chain %d: %v", chainID, err)
			}
			cs.Wait()
		}(chainSyncer, cfg.ChainID)

		log.Printf("Started syncer for chain %d", cfg.ChainID)
	}

	// Wait for shutdown signal
	<-sigChan
	log.Println("Received shutdown signal, stopping all syncers...")
	for _, cs := range syncers {
		cs.Stop()
	}

	wg.Wait()
	log.Println("All syncers stopped")
}
