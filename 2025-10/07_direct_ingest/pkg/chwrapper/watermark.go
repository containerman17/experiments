package chwrapper

import (
	"context"
	"fmt"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// GetWatermark returns the current watermark block number, or 0 if not set
func GetWatermark(conn driver.Conn) (uint32, error) {
	ctx := context.Background()

	query := "SELECT block_number FROM watermark WHERE id = 1"

	row := conn.QueryRow(ctx, query)
	var blockNumber uint32
	if err := row.Scan(&blockNumber); err != nil {
		// No watermark exists yet
		return 0, nil
	}

	return blockNumber, nil
}

// SetWatermark updates the watermark to the given block number
func SetWatermark(conn driver.Conn, blockNumber uint32) error {
	ctx := context.Background()

	query := "INSERT INTO watermark (id, block_number) VALUES (1, ?)"

	if err := conn.Exec(ctx, query, blockNumber); err != nil {
		return fmt.Errorf("failed to set watermark: %w", err)
	}

	return nil
}
