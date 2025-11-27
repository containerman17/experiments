package clickhouse

import (
	"context"
	"crypto/tls"
	"database/sql"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
)

type Client struct {
	db *sql.DB
}

func New(host, user, password string) *Client {
	conn := clickhouse.OpenDB(&clickhouse.Options{
		Addr:     []string{host},
		Protocol: clickhouse.HTTP,
		TLS:      &tls.Config{},
		Auth: clickhouse.Auth{
			Username: user,
			Password: password,
		},
	})
	conn.SetMaxOpenConns(5)
	conn.SetMaxIdleConns(2)
	conn.SetConnMaxLifetime(time.Hour)

	return &Client{db: conn}
}

func (c *Client) Close() error {
	return c.db.Close()
}

// Query executes a query with retry on connection errors.
// Placeholders: {chain_id}, {period_start}, {period_end}, {granularity}
func (c *Client) Query(ctx context.Context, query string, chainID uint32, periodStart, periodEnd time.Time, granularity string) (*sql.Rows, error) {
	// Replace placeholders
	q := query
	q = strings.ReplaceAll(q, "{chain_id}", fmt.Sprintf("%d", chainID))
	q = strings.ReplaceAll(q, "{period_start}", fmt.Sprintf("toDateTime64('%s', 3)", periodStart.UTC().Format("2006-01-02 15:04:05.000")))
	q = strings.ReplaceAll(q, "{period_end}", fmt.Sprintf("toDateTime64('%s', 3)", periodEnd.UTC().Format("2006-01-02 15:04:05.000")))
	q = strings.ReplaceAll(q, "{granularity}", granularity)

	// CamelCase granularity for toStartOf functions
	granCamel := granularity
	if len(granCamel) > 0 {
		granCamel = strings.ToUpper(granCamel[:1]) + granCamel[1:]
	}
	q = strings.ReplaceAll(q, "{granularityCamelCase}", granCamel)

	return c.queryWithRetry(ctx, q)
}

// QueryRaw executes a raw query with retry
func (c *Client) QueryRaw(ctx context.Context, query string) (*sql.Rows, error) {
	return c.queryWithRetry(ctx, query)
}

func (c *Client) queryWithRetry(ctx context.Context, query string) (*sql.Rows, error) {
	log.Printf("QUERY: %s", query)
	var lastErr error
	for attempt := 0; attempt < 5; attempt++ {
		rows, err := c.db.QueryContext(ctx, query)
		if err == nil {
			return rows, nil
		}
		lastErr = err

		// Check if it's a connection error (retry) vs query error (fatal)
		errStr := err.Error()
		if strings.Contains(errStr, "connection") ||
			strings.Contains(errStr, "EOF") ||
			strings.Contains(errStr, "timeout") ||
			strings.Contains(errStr, "broken pipe") {
			log.Printf("clickhouse connection error (attempt %d/5): %v", attempt+1, err)
			time.Sleep(time.Duration(attempt+1) * time.Second)
			continue
		}

		// Not a connection error, don't retry
		return nil, err
	}
	return nil, fmt.Errorf("clickhouse query failed after 5 attempts: %w", lastErr)
}

// ChainWatermark represents a chain's sync state
type ChainWatermark struct {
	ChainID     uint32
	BlockNumber uint32
}

// GetSyncWatermarks returns all chain watermarks
func (c *Client) GetSyncWatermarks(ctx context.Context) ([]ChainWatermark, error) {
	rows, err := c.QueryRaw(ctx, "SELECT chain_id, block_number FROM sync_watermark")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var watermarks []ChainWatermark
	for rows.Next() {
		var w ChainWatermark
		if err := rows.Scan(&w.ChainID, &w.BlockNumber); err != nil {
			return nil, err
		}
		watermarks = append(watermarks, w)
	}
	return watermarks, rows.Err()
}

// GetBlockTime returns the block_time for a given chain and block number
func (c *Client) GetBlockTime(ctx context.Context, chainID, blockNumber uint32) (time.Time, error) {
	query := fmt.Sprintf(`
		SELECT block_time 
		FROM raw_blocks 
		WHERE chain_id = %d AND block_number = %d 
		LIMIT 1
	`, chainID, blockNumber)

	rows, err := c.QueryRaw(ctx, query)
	if err != nil {
		return time.Time{}, err
	}
	defer rows.Close()

	if !rows.Next() {
		return time.Time{}, fmt.Errorf("block not found: chain=%d block=%d", chainID, blockNumber)
	}

	var blockTime time.Time
	if err := rows.Scan(&blockTime); err != nil {
		return time.Time{}, err
	}
	return blockTime, nil
}

// GetMinBlockTime returns the minimum block_time for a chain
func (c *Client) GetMinBlockTime(ctx context.Context, chainID uint32) (time.Time, error) {
	query := fmt.Sprintf(`
		SELECT min(block_time) 
		FROM raw_blocks 
		WHERE chain_id = %d
	`, chainID)

	rows, err := c.QueryRaw(ctx, query)
	if err != nil {
		return time.Time{}, err
	}
	defer rows.Close()

	if !rows.Next() {
		return time.Time{}, fmt.Errorf("no blocks found for chain %d", chainID)
	}

	var minTime time.Time
	if err := rows.Scan(&minTime); err != nil {
		return time.Time{}, err
	}
	return minTime, nil
}

