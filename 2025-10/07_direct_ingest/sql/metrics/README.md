# Metrics SQL Query Templates

This directory contains SQL templates for computing blockchain metrics at various time granularities.

## Supported Granularities

- **Minute** - 60-second periods
- **Hour** - 3600-second periods  
- **Day** - 86400-second periods
- **Week** - 604800-second periods (Sunday start, matching ClickHouse)
- **Month** - Variable duration (actual calendar months)

## Template Placeholders

The metrics runner replaces the following placeholders when executing queries:

| Placeholder | Description | Example Value |
|------------|-------------|---------------|
| `{chain_id:UInt32}` | Blockchain chain ID | `43114` |
| `{first_period:DateTime}` | Start of period range (inclusive) | `'2024-01-01 00:00:00'` |
| `{last_period:DateTime}` | End of period range (exclusive) | `'2024-01-02 00:00:00'` |
| `{first_period:Date}` | Start date for Date columns | `'2024-01-01'` |
| `{last_period:Date}` | End date for Date columns | `'2024-01-02'` |
| `{granularity}` | Time granularity (lowercase for tables) | `hour` |
| `toStartOf{granularity}` | ClickHouse function name | `toStartOfHour` |
| `_{granularity}` | Table name suffix | `_hour` |
| `{period_seconds:UInt64}` | Seconds in the period | `3600` |

## Query Design Principles

### 1. Table Naming Convention
```sql
CREATE TABLE IF NOT EXISTS metric_name_{granularity} (
    chain_id UInt32,
    period DateTime,  -- Use DateTime for all granularities
    value UInt64,     -- Or appropriate type for metric
    computed_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (chain_id, period);
```

### 2. Period Column Type
- Use `DateTime` for all metrics (supports all granularities)
- DateTime allows minute/hour/day/week/month aggregations
- All metrics now support all time granularities

### 3. Time Range Filtering
```sql
WHERE chain_id = {chain_id:UInt32}
  AND block_time >= {first_period:DateTime}  -- Inclusive
  AND block_time < {last_period:DateTime}    -- Exclusive
```

### 4. Period Aggregation
```sql
SELECT
    toStartOf{granularity}(block_time) as period,
    -- metric calculation
GROUP BY period
```

### 5. Average Metrics
For time-based averages (TPS, GPS), divide by period duration:
```sql
CAST(count(*) / {period_seconds:UInt64} AS UInt64) as value
```

## Metric Categories

### Transaction Metrics
- `tx_count` - Transaction count per period
- `avg_tps` - Average transactions per second
- `max_tps` - Maximum TPS within period

### Gas Metrics  
- `gas_used` - Total gas consumed
- `avg_gps` - Average gas per second
- `max_gps` - Maximum GPS within period
- `avg_gas_price` - Average gas price
- `max_gas_price` - Maximum gas price
- `fees_paid` - Total transaction fees (gas_used × gas_price)

### Address Metrics
- `active_addresses` - Unique addresses (from + to)
- `active_senders` - Unique transaction senders
- `deployers` - Unique contract deployers
- `contracts` - New contracts deployed

### Cumulative Metrics (All Granularities)
- `cumulative_tx_count` - Running total of transactions
- `cumulative_addresses` - Running total of unique addresses
- `cumulative_contracts` - Running total of contracts
- `cumulative_deployers` - Running total of deployers

## Adding New Metrics

1. Create SQL file: `metric_name.sql`
2. Use appropriate template structure
3. Include all required placeholders
4. **Always use `DateTime` for period column**
5. **Always include `{granularity}` placeholder in table names**
6. Test with all granularities (Minute, Hour, Day, Week, Month)

### Example Template
```sql
-- My New Metric
-- Parameters: chain_id, first_period, last_period, granularity
-- Description of what this metric calculates

CREATE TABLE IF NOT EXISTS my_metric_{granularity} (
    chain_id UInt32,
    period DateTime,
    value UInt64,
    computed_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (chain_id, period);

INSERT INTO my_metric_{granularity} (chain_id, period, value)
SELECT
    {chain_id:UInt32} as chain_id,
    toStartOf{granularity}(block_time) as period,
    -- your calculation here
FROM raw_transactions  -- or appropriate table
WHERE chain_id = {chain_id:UInt32}
  AND block_time >= {first_period:DateTime}
  AND block_time < {last_period:DateTime}
GROUP BY period
ORDER BY period;
```

## Processing Logic

The metrics runner:
1. Tracks latest block time per chain
2. Detects when periods are "complete" (sees block from next period)
3. Executes metrics for all completed periods in batch
4. Updates last processed timestamp

This ensures metrics are only calculated for periods with complete data, avoiding partial period calculations that could be misleading.

## Important Notes

- **All metrics must support all granularities** - No exceptions
- **Always use `{granularity}` placeholder** in table names
- **Always use `DateTime` column type** for periods
- The system creates tables like: `metric_name_minute`, `metric_name_hour`, `metric_name_day`, `metric_name_week`, `metric_name_month`
- Cumulative metrics show "up and to the right" growth charts at any granularity