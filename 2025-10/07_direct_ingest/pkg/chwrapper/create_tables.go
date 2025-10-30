package chwrapper

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"strings"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

//go:embed raw_tables.sql
var rawTablesSQL string

//go:embed mvs/*.sql
var mvsFS embed.FS

func CreateTables(conn driver.Conn) error {
	err := ExecuteSql(conn, rawTablesSQL)
	if err != nil {
		return fmt.Errorf("failed to create tables: %w", err)
	}

	mvsFiles, err := fs.Glob(mvsFS, "mvs/*.sql")
	if err != nil {
		return fmt.Errorf("failed to list mvs files: %w", err)
	}

	for _, filePath := range mvsFiles {
		sql, err := mvsFS.ReadFile(filePath)
		if err != nil {
			return fmt.Errorf("failed to read %s: %w", filePath, err)
		}

		err = ExecuteSql(conn, string(sql))
		if err != nil {
			return fmt.Errorf("failed to execute %s: %w", filePath, err)
		}
	}

	return nil
}

func ExecuteSql(conn driver.Conn, sql string) error {
	ctx := context.Background()

	statements := strings.Split(sql, ";")

	for _, stmt := range statements {
		// Remove comment lines
		var lines []string
		for _, line := range strings.Split(stmt, "\n") {
			trimmed := strings.TrimSpace(line)
			if !strings.HasPrefix(trimmed, "--") && trimmed != "" {
				lines = append(lines, line)
			}
		}

		cleanStmt := strings.TrimSpace(strings.Join(lines, "\n"))
		if cleanStmt == "" {
			continue
		}

		if err := conn.Exec(ctx, cleanStmt); err != nil {
			return fmt.Errorf("failed to execute statement: %w", err)
		}
	}

	return nil
}
