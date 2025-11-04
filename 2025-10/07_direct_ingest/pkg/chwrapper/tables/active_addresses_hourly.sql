-- ================================================
-- ACTIVE ADDRESSES HOURLY - REFRESHABLE MV APPROACH
-- ================================================
-- Computes stats every minute, but excludes the latest blockchain hour
-- This ensures we only count complete hours

-- Stats table with pre-computed counts
CREATE TABLE IF NOT EXISTS active_addresses_hourly_stats (
    chain_id UInt32,
    hour DateTime,
    unique_addresses UInt64,
    computed_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (chain_id, hour);

-- Refreshable MV that recalculates every hour
-- Only processes COMPLETE hours (excludes the latest blockchain hour)
-- Optimized to only recompute recent data (last 3 hours by insertion time)
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_active_addresses_hourly_stats
REFRESH EVERY 1 HOUR
TO active_addresses_hourly_stats
AS
WITH 
    latest_insert AS (
        -- Get the most recent insertion time
        SELECT max(inserted_at) as max_inserted_at
        FROM raw_traces
    ),
    max_block_hour AS (
        -- Get the latest hour that has data (blockchain time, not wall time)
        SELECT toStartOfHour(max(block_time)) as latest_hour
        FROM raw_traces
        WHERE inserted_at >= (SELECT max_inserted_at FROM latest_insert) - INTERVAL 3 HOUR
    ),
    affected_hours AS (
        -- Find which hours were recently modified (last 3 hours of insertions)
        SELECT DISTINCT toStartOfHour(block_time) as hour
        FROM raw_traces
        WHERE inserted_at >= (SELECT max_inserted_at FROM latest_insert) - INTERVAL 3 HOUR
          AND toStartOfHour(block_time) < (SELECT latest_hour FROM max_block_hour)
    )
SELECT
    chain_id,
    hour,
    uniq(address) as unique_addresses,
    now() as computed_at
FROM (
    -- Get all addresses for recently modified COMPLETE hours
    SELECT 
        chain_id,
        toStartOfHour(block_time) as hour,
        from as address
    FROM raw_traces
    WHERE toStartOfHour(block_time) IN (SELECT hour FROM affected_hours)
      AND from != unhex('0000000000000000000000000000000000000000')
    
    UNION ALL
    
    SELECT 
        chain_id,
        toStartOfHour(block_time) as hour,
        to as address
    FROM raw_traces
    WHERE toStartOfHour(block_time) IN (SELECT hour FROM affected_hours)
      AND to IS NOT NULL
      AND to != unhex('0000000000000000000000000000000000000000')
)
GROUP BY chain_id, hour;

-- ================================================
-- USAGE
-- ================================================
-- Direct query - pre-computed number:
-- SELECT unique_addresses 
-- FROM active_addresses_hourly_stats 
-- WHERE chain_id = 1 AND hour = '2024-01-01 12:00:00';

-- Get trend:
-- SELECT hour, unique_addresses 
-- FROM active_addresses_hourly_stats
-- WHERE chain_id = 1 AND hour >= now() - INTERVAL 7 DAY
-- ORDER BY hour;

-- Check freshness:
-- SELECT max(computed_at), max(hour) 
-- FROM active_addresses_hourly_stats;

-- ================================================
-- RECOVERY (if needed after crash)
-- ================================================
-- The MV will automatically recalculate on next refresh
-- To force immediate recalculation:
-- SYSTEM REFRESH VIEW mv_active_addresses_hourly_stats;