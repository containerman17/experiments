package chwrapper

import (
	"context"
	_ "embed"
	"fmt"
	"strings"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

//go:embed raw_tables.sql
var rawTablesSQL string

func CreateTables(conn driver.Conn) error {
	ctx := context.Background()

	statements := strings.Split(rawTablesSQL, ";")

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
