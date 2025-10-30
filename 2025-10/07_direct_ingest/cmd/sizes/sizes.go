package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"clickhouse-metrics-poc/pkg/chwrapper"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

type tableSize struct {
	database     string
	name         string
	rowsMillions float64
	sizeGB       float64
}

type dirSize struct {
	path   string
	sizeGB float64
}

func main() {
	fmt.Println("=== ClickHouse Table Sizes ===")
	fmt.Println()

	conn, err := chwrapper.Connect()
	if err != nil {
		log.Fatalf("Failed to connect: %v", err)
	}
	defer conn.Close()

	if err := showTableSizes(conn); err != nil {
		log.Fatalf("Failed to show table sizes: %v", err)
	}

	fmt.Println()
	fmt.Println("=== Disk Usage: ./data/ ===")
	fmt.Println()
	if err := showDataSizes("./data"); err != nil {
		log.Fatalf("Failed to show data sizes: %v", err)
	}
}

func showTableSizes(conn driver.Conn) error {
	ctx := context.Background()

	query := `
		SELECT 
			database,
			name,
			total_rows / 1000000.0 as rows_millions,
			total_bytes / (1024.0 * 1024.0 * 1024.0) as size_gb
		FROM system.tables
		WHERE database = currentDatabase()
		ORDER BY total_bytes DESC
	`

	rows, err := conn.Query(ctx, query)
	if err != nil {
		return fmt.Errorf("failed to query tables: %w", err)
	}
	defer rows.Close()

	var tables []tableSize
	for rows.Next() {
		var t tableSize
		if err := rows.Scan(&t.database, &t.name, &t.rowsMillions, &t.sizeGB); err != nil {
			return fmt.Errorf("failed to scan row: %w", err)
		}
		tables = append(tables, t)
	}

	if err := rows.Err(); err != nil {
		return fmt.Errorf("row iteration error: %w", err)
	}

	if len(tables) == 0 {
		fmt.Println("No tables found")
		return nil
	}

	const maxNameLen = 50
	fmt.Printf("%-*s %15s %15s\n", maxNameLen, "Table", "Rows (M)", "Size (GB)")
	fmt.Println(strings.Repeat("-", maxNameLen+32))
	
	var totalRows, totalSize float64
	for _, t := range tables {
		name := t.name
		if len(name) > maxNameLen {
			name = name[:maxNameLen-3] + "..."
		}
		fmt.Printf("%-*s %15.2f %15.2f\n", maxNameLen, name, t.rowsMillions, t.sizeGB)
		totalRows += t.rowsMillions
		totalSize += t.sizeGB
	}
	
	fmt.Println(strings.Repeat("-", maxNameLen+32))
	fmt.Printf("%-*s %15.2f %15.2f\n", maxNameLen, "TOTAL", totalRows, totalSize)

	return nil
}

func showDataSizes(rootPath string) error {
	info, err := os.Stat(rootPath)
	if err != nil {
		if os.IsNotExist(err) {
			fmt.Printf("Directory %s does not exist\n", rootPath)
			return nil
		}
		return fmt.Errorf("failed to stat %s: %w", rootPath, err)
	}

	if !info.IsDir() {
		return fmt.Errorf("%s is not a directory", rootPath)
	}

	var dirs []dirSize

	err = filepath.Walk(rootPath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		if !info.IsDir() {
			return nil
		}

		size, err := calculateDirSize(path)
		if err != nil {
			return fmt.Errorf("failed to calculate size for %s: %w", path, err)
		}

		relPath, err := filepath.Rel(rootPath, path)
		if err != nil {
			relPath = path
		}

		dirs = append(dirs, dirSize{
			path:   relPath,
			sizeGB: float64(size) / (1024.0 * 1024.0 * 1024.0),
		})

		return nil
	})

	if err != nil {
		return fmt.Errorf("failed to walk directory: %w", err)
	}

	sort.Slice(dirs, func(i, j int) bool {
		return dirs[i].sizeGB > dirs[j].sizeGB
	})

	fmt.Printf("%-50s %15s\n", "Directory", "Size (GB)")
	fmt.Println("------------------------------------------------------------------------")
	
	var totalSize float64
	for _, d := range dirs {
		if d.sizeGB > 0 || d.path == "." {
			fmt.Printf("%-50s %15.2f\n", d.path, d.sizeGB)
			totalSize += d.sizeGB
		}
	}
	
	fmt.Println("------------------------------------------------------------------------")
	fmt.Printf("%-50s %15.2f\n", "TOTAL", totalSize)

	return nil
}

func calculateDirSize(path string) (int64, error) {
	var size int64
	err := filepath.Walk(path, func(_ string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() {
			size += info.Size()
		}
		return nil
	})
	return size, err
}
