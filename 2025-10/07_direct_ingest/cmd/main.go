package main

import (
	"fmt"
	"os"
)

func main() {
	//FIXME: Cobra one day?
	if len(os.Args) < 2 {
		printHelp()
		os.Exit(1)
	}

	command := os.Args[1]

	switch command {
	case "ingest":
		runIngest()
	case "backfill":
		runBackfill()
	case "sizes":
		runSizes()
	case "wipedb":
		runWipedb()
	case "--help", "-h", "help":
		printHelp()
	default:
		fmt.Printf("Unknown command: %s\n\n", command)
		printHelp()
		os.Exit(1)
	}
}

func printHelp() {
	fmt.Println("Usage: clickhouse-ingest [command]")
	fmt.Println()
	fmt.Println("Commands:")
	fmt.Println("  ingest      Start the continuous ingestion process")
	fmt.Println("  backfill    Drop materialized views and rebuild from raw data")
	fmt.Println("  sizes       Show ClickHouse table sizes and disk usage")
	fmt.Println("  wipedb      Drop all tables and materialized views")
	fmt.Println("  help        Show this help message")
}
