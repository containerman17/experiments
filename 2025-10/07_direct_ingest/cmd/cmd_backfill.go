package main

import (
	"bufio"
	"clickhouse-metrics-poc/pkg/chwrapper"
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

func runBackfill() {
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

	// Collect what will be dropped
	var mvsToDelete []string
	var tablesToDelete []string

	for _, mv := range mvs {
		if !shouldKeepTable(mv) {
			mvsToDelete = append(mvsToDelete, mv)
		}
	}

	for _, table := range tables {
		if !shouldKeepTable(table) {
			tablesToDelete = append(tablesToDelete, table)
		}
	}

	// Show what will be dropped and ask for confirmation
	if len(mvsToDelete) > 0 || len(tablesToDelete) > 0 {
		fmt.Println("\nThe following will be dropped:")

		if len(mvsToDelete) > 0 {
			fmt.Println("\nMaterialized Views:")
			for _, mv := range mvsToDelete {
				fmt.Printf("  - %s\n", mv)
			}
		}

		if len(tablesToDelete) > 0 {
			fmt.Println("\nTables:")
			for _, table := range tablesToDelete {
				fmt.Printf("  - %s\n", table)
			}
		}

		fmt.Printf("\nAre you sure you want to drop these %d materialized view(s) and %d table(s)? (y/n): ", len(mvsToDelete), len(tablesToDelete))

		reader := bufio.NewReader(os.Stdin)
		response, err := reader.ReadString('\n')
		if err != nil {
			log.Fatalf("Failed to read input: %v", err)
		}

		response = strings.TrimSpace(strings.ToLower(response))
		if response != "y" && response != "yes" {
			log.Println("Aborted by user")
			return
		}
	} else {
		log.Println("No tables or MVs to drop")
	}

	// Step 2: Drop all MVs and tables except raw_* and sync_watermark
	log.Println("\nStep 2: Dropping existing MVs and tables (except raw_* and sync_watermark)...")

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

	// Step 3: Execute all material_views/tables/*.sql
	log.Println("Step 3: Creating tables and materialized views...")
	tableFiles, err := scanSQLFiles("material_views/tables")
	if err != nil {
		log.Fatalf("Failed to get table SQL files: %v", err)
	}

	sort.Strings(tableFiles)

	for _, path := range tableFiles {
		sql, err := os.ReadFile(path)
		if err != nil {
			log.Fatalf("Failed to read %s: %v", path, err)
		}
		log.Printf("  Executing: %s", path)
		if err := chwrapper.ExecuteSql(conn, string(sql)); err != nil {
			log.Fatalf("  Failed to execute %s: %v", path, err)
		}
	}

	// Step 4: Execute all material_views/backfill/*.sql
	log.Println("Step 4: Running backfill scripts...")
	backfillFiles, err := scanSQLFiles("material_views/backfill")
	if err != nil {
		log.Fatalf("Failed to get backfill SQL files: %v", err)
	}

	sort.Strings(backfillFiles)

	for _, path := range backfillFiles {
		sql, err := os.ReadFile(path)
		if err != nil {
			log.Fatalf("Failed to read %s: %v", path, err)
		}
		log.Printf("  Executing: %s", path)
		start := time.Now()
		if err := chwrapper.ExecuteSql(conn, string(sql)); err != nil {
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

func scanSQLFiles(dir string) ([]string, error) {
	var files []string
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}

	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".sql" {
			continue
		}
		files = append(files, filepath.Join(dir, entry.Name()))
	}

	return files, nil
}
