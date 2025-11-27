package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"log"
	"math/big"
	"os"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/joho/godotenv"
)

func main() {
	godotenv.Overload()

	host := os.Getenv("CLICKHOUSE_HOST")
	user := os.Getenv("CLICKHOUSE_USER")
	password := os.Getenv("CLICKHOUSE_PASSWORD")

	if host == "" || user == "" {
		log.Fatal("CLICKHOUSE_HOST and CLICKHOUSE_USER are required")
	}

	conn := clickhouse.OpenDB(&clickhouse.Options{
		Addr:     []string{host},
		Protocol: clickhouse.HTTP,
		TLS:      &tls.Config{},
		Auth: clickhouse.Auth{
			Username: user,
			Password: password,
		},
	})
	defer conn.Close()

	ctx := context.Background()

	// Query UInt256 values that overflow uint64 (max uint64 = 18446744073709551615)
	rows, err := conn.QueryContext(ctx, `
		SELECT value 
		FROM raw_txs 
		WHERE value > 18446744073709551615 
		LIMIT 5
	`)
	if err != nil {
		log.Fatal("Query failed:", err)
	}
	defer rows.Close()

	uint64Max := new(big.Int).SetUint64(^uint64(0))
	fmt.Printf("uint64 max: %s\n\n", uint64Max.String())
	fmt.Println("Testing big.Int scan for UInt256 (values > uint64 max):")
	for rows.Next() {
		var value big.Int
		if err := rows.Scan(&value); err != nil {
			log.Printf("Scan error: %v", err)
			continue
		}
		fmt.Printf("  value: %s (%d bits)\n", value.String(), value.BitLen())
	}

	if err := rows.Err(); err != nil {
		log.Fatal("Row error:", err)
	}

	fmt.Println("\nDone!")
}
