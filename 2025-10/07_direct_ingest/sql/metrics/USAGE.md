# Metric SQL Usage

All metrics support batch processing for efficient backfill.

## Parameters

- `{chain_id}` - Chain ID to process
- `{first_period}` - Start of period range (inclusive)
- `{last_period}` - End of period range (exclusive for minute/hour/day, inclusive for cumulative)
- `{granularity}` - Minute, Hour, Day, Week, or Month (capitalized for ClickHouse functions)

## Examples

### Single Period (real-time processing)
Process just hour 14:00-15:00 on 2024-01-15:
```
first_period = '2024-01-15 14:00:00'
last_period = '2024-01-15 15:00:00'  
granularity = 'Hour'
```

### Batch Processing (backfill)
Process all hours for entire month of January 2024:
```
first_period = '2024-01-01 00:00:00'
last_period = '2024-02-01 00:00:00'
granularity = 'Hour'
```
This returns 744 rows (31 days × 24 hours) in one query.

## Notes

- `toStartOf{granularity}` becomes `toStartOfMinute`, `toStartOfHour`, etc.
- Batch processing dramatically reduces backfill time (one query vs thousands)
- ReplacingMergeTree handles duplicates if you re-process periods
