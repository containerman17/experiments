package main

import (
	"clickhouse-metrics-poc/pkg/chwrapper"
	"context"
	"fmt"
	"log"
	"sort"
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

func main() {
	log.Println("Starting backfill process...")

	// Connect to ClickHouse
	conn, err := chwrapper.Connect()
	if err != nil {
		log.Fatalf("Failed to connect to ClickHouse: %v", err)
	}
	defer conn.Close()

	ctx := context.Background()

	// Step 1: Get list of all tables and materialized views
	log.Println("Step 1: Getting list of tables and materialized views...")
	tables, mvs, err := getTablesAndMVs(conn, ctx)
	if err != nil {
		log.Fatalf("Failed to get tables and MVs: %v", err)
	}

	// Step 2: Drop all MVs and tables except raw_* and sync_watermark
	log.Println("Step 2: Dropping existing MVs and tables (except raw_* and sync_watermark)...")

	// Drop MVs first (they depend on tables)
	for _, mv := range mvs {
		if !shouldKeepTable(mv) {
			log.Printf("  Dropping MV: %s", mv)
			if err := conn.Exec(ctx, fmt.Sprintf("DROP VIEW IF EXISTS %s", mv)); err != nil {
				log.Printf("  Warning: Failed to drop MV %s: %v", mv, err)
			}
		}
	}

	// Then drop tables
	for _, table := range tables {
		if !shouldKeepTable(table) {
			log.Printf("  Dropping table: %s", table)
			if err := conn.Exec(ctx, fmt.Sprintf("DROP TABLE IF EXISTS %s", table)); err != nil {
				log.Printf("  Warning: Failed to drop table %s: %v", table, err)
			}
		}
	}

	// Step 3: Execute all tables/*.sql
	log.Println("Step 3: Creating tables and materialized views...")
	tableFiles, err := chwrapper.GetTablesSQLFiles()
	if err != nil {
		log.Fatalf("Failed to get table SQL files: %v", err)
	}

	// Sort file paths for consistent execution order
	var sortedTablePaths []string
	for path := range tableFiles {
		sortedTablePaths = append(sortedTablePaths, path)
	}
	sort.Strings(sortedTablePaths)

	for _, path := range sortedTablePaths {
		sql := tableFiles[path]
		log.Printf("  Executing: %s", path)
		if err := chwrapper.ExecuteSql(conn, sql); err != nil {
			log.Fatalf("  Failed to execute %s: %v", path, err)
		}
	}

	// Step 4: Execute all backfill/*.sql
	log.Println("Step 4: Running backfill scripts...")
	backfillFiles, err := chwrapper.GetBackfillSQLFiles()
	if err != nil {
		log.Fatalf("Failed to get backfill SQL files: %v", err)
	}

	// Sort file paths for consistent execution order
	var sortedBackfillPaths []string
	for path := range backfillFiles {
		sortedBackfillPaths = append(sortedBackfillPaths, path)
	}
	sort.Strings(sortedBackfillPaths)

	for _, path := range sortedBackfillPaths {
		sql := backfillFiles[path]
		log.Printf("  Executing: %s", path)
		start := time.Now()
		if err := chwrapper.ExecuteSql(conn, sql); err != nil {
			log.Fatalf("  Failed to execute %s: %v", path, err)
		}
		duration := time.Since(start)
		log.Printf("  Completed: %s (took %v)", path, duration)
	}

	log.Println("Backfill process completed successfully!")
}

func getTablesAndMVs(conn driver.Conn, ctx context.Context) ([]string, []string, error) {
	var tables []string
	var mvs []string

	// Get all tables
	rows, err := conn.Query(ctx, `
		SELECT name, engine 
		FROM system.tables 
		WHERE database = currentDatabase()
		  AND engine NOT IN ('View', 'MaterializedView', 'LiveView')
	`)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var name, engine string
		if err := rows.Scan(&name, &engine); err != nil {
			return nil, nil, err
		}
		tables = append(tables, name)
	}

	// Get all materialized views
	rows, err = conn.Query(ctx, `
		SELECT name 
		FROM system.tables 
		WHERE database = currentDatabase()
		  AND engine IN ('MaterializedView')
	`)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, nil, err
		}
		mvs = append(mvs, name)
	}

	return tables, mvs, nil
}

func shouldKeepTable(tableName string) bool {
	// Keep raw_* tables and sync_watermark
	return strings.HasPrefix(tableName, "raw_") || tableName == "sync_watermark"
}
