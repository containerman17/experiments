#!/bin/bash
set -e

OUTPUT_DIR="./data/parquet_logs"
PARALLEL_JOBS=16
mkdir -p "$OUTPUT_DIR"

export_month() {
    local CURRENT="$1"
    local YEAR=$(date -d "$CURRENT" +%Y)
    local MONTH=$(date -d "$CURRENT" +%m)
    local NEXT_MONTH=$(date -d "$CURRENT + 1 month" +%Y-%m-%d)
    local OUTPUT_FILE="$OUTPUT_DIR/logs_${YEAR}_${MONTH}.parquet"
    
    if [[ -f "$OUTPUT_FILE" ]]; then
        echo "SKIP: $OUTPUT_FILE"
        return
    fi
    
    echo "START: $YEAR-$MONTH"
    clickhouse-client --query="
        SELECT * FROM raw_logs 
        WHERE block_time >= '$CURRENT' AND block_time < '$NEXT_MONTH'
        FORMAT Parquet
    " > "$OUTPUT_FILE"
    
    local SIZE=$(du -h "$OUTPUT_FILE" | cut -f1)
    echo "DONE: $YEAR-$MONTH ($SIZE)"
}
export -f export_month
export OUTPUT_DIR

# Get min/max dates from raw_logs
echo "Detecting date range..."
DATE_RANGE=$(clickhouse-client --query="
    SELECT 
        toStartOfMonth(min(block_time)) as min_month,
        toStartOfMonth(max(block_time)) as max_month
    FROM raw_logs
    FORMAT TSV
")

MIN_MONTH=$(echo "$DATE_RANGE" | cut -f1)
MAX_MONTH=$(echo "$DATE_RANGE" | cut -f2)

echo "Data range: $MIN_MONTH to $MAX_MONTH"
echo "Parallel jobs: $PARALLEL_JOBS"
echo ""

# Generate all months
MONTHS=()
CURRENT="$MIN_MONTH"
while [[ "$CURRENT" < "$MAX_MONTH" ]] || [[ "$CURRENT" == "$MAX_MONTH" ]]; do
    MONTHS+=("$CURRENT")
    CURRENT=$(date -d "$CURRENT + 1 month" +%Y-%m-%d)
done

# Run in parallel
printf '%s\n' "${MONTHS[@]}" | xargs -P "$PARALLEL_JOBS" -I {} bash -c 'export_month "$@"' _ {}

echo ""
echo "Export complete. Total size:"
du -sh "$OUTPUT_DIR"
