#!/bin/bash

DIR="./data/parquet_logs"

echo "Checking Parquet files in $DIR..."
echo ""

for f in "$DIR"/*.parquet; do
    if clickhouse-local --query="SELECT count() FROM file('$f', 'Parquet')" > /dev/null 2>&1; then
        SIZE=$(du -h "$f" | cut -f1)
        echo "OK: $f ($SIZE)"
    else
        echo "CORRUPTED: $f"
    fi
done
