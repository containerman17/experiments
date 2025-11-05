# Ultra-Simple Metrics Package

## Design Philosophy
- **NO complex state management** - Everything is in the database
- **NO parsing** - Just split SQL by semicolons and execute
- **ALL milliseconds** - No conversions between seconds/milliseconds
- **Watermarks for everything** - Simple, crash-safe state tracking

## How it Works

1. **Watermark Table**: Tracks last processed period for each metric
   ```sql
   metric_watermarks (
       chain_id, 
       metric_name,  -- e.g., "tx_count_minute"
       last_period   -- milliseconds
   )
   ```

2. **Processing Flow**:
   - Get watermark (last processed period)
   - Calculate periods to process
   - Read SQL file and execute statements
   - Update watermark

3. **SQL Files**: Can contain multiple statements
   - CREATE TABLE statements (idempotent)
   - INSERT statements (use ReplacingMergeTree)
   - Related metrics in same file (e.g., tx_count + cumulative_tx_count)

## Benefits

- **Dead simple**: ~200 lines instead of 500+
- **Crash safe**: State in DB, not memory
- **Easy reset**: Just `DELETE FROM metric_watermarks WHERE metric_name = 'tx_count_minute'`
- **Full reset**: `TRUNCATE TABLE metric_watermarks`
- **Idempotent**: ReplacingMergeTree handles duplicates

## Period Math

All calculations in milliseconds:
- **Minute**: `ms - (ms % 60000)`
- **Hour**: `ms - (ms % 3600000)`
- **Day**: `ms - (ms % 86400000)`
- **Week**: Uses Jan 1, 1970 = Thursday fact
- **Month**: Only place using time.Time (calendar math)

## Usage

```go
runner := NewMetricsRunner(conn, "sql/metrics")
runner.OnBlock(blockTimestampMs, chainId)
```

That's it. No configuration, no complex initialization.
