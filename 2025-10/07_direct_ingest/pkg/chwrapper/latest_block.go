package chwrapper

import (
	"context"
	"fmt"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// GetLatestBlockForChain returns max block_number for a specific chain from the specified table
func GetLatestBlockForChain(conn driver.Conn, table string, chainID uint32) (uint32, error) {
	ctx := context.Background()

	query := fmt.Sprintf("SELECT max(block_number) FROM %s WHERE chain_id = ?", table)

	row := conn.QueryRow(ctx, query, chainID)
	var maxVal uint32
	if err := row.Scan(&maxVal); err != nil {
		return 0, fmt.Errorf("failed to query max(block_number) from %s for chain %d: %w", table, chainID, err)
	}

	return maxVal, nil
}
