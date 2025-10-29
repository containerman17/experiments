package chwrapper

import (
	"context"
	"fmt"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// GetLatestBlock returns max block_number from the specified table
func GetLatestBlock(conn driver.Conn, table string) (uint32, error) {
	ctx := context.Background()

	query := fmt.Sprintf("SELECT max(block_number) FROM %s", table)

	row := conn.QueryRow(ctx, query)
	var maxVal uint32
	if err := row.Scan(&maxVal); err != nil {
		return 0, fmt.Errorf("failed to query max(block_number) from %s: %w", table, err)
	}

	return maxVal, nil
}
