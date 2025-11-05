-- ================================================
-- ACTIVE ADDRESSES PER DAY
-- ================================================
-- Daily aggregation of unique addresses
-- Refreshable MV approach with exclusion of incomplete days

-- Stats table with pre-computed counts
CREATE TABLE IF NOT EXISTS active_addresses_per_day (
    chain_id UInt32,
    day Date,
    unique_addresses UInt64,
    computed_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (chain_id, day);

-- Refreshable MV that recalculates every hour
-- Only processes COMPLETE days (excludes the latest blockchain day)
-- Optimized to only recompute recent data (last 3 days by insertion time)
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_active_addresses_per_day
REFRESH EVERY 1 HOUR
TO active_addresses_per_day
AS
WITH 
    latest_insert AS (
        -- Get the most recent insertion time
        SELECT max(inserted_at) as max_inserted_at
        FROM raw_traces
    ),
    max_block_day AS (
        -- Get the latest day that has data (blockchain time, not wall time)
        SELECT toDate(max(block_time)) as latest_day
        FROM raw_traces
        WHERE inserted_at >= (SELECT max_inserted_at FROM latest_insert) - INTERVAL 3 DAY
    ),
    affected_days AS (
        -- Find which days were recently modified (last 3 days of insertions)
        SELECT DISTINCT toDate(block_time) as day
        FROM raw_traces
        WHERE inserted_at >= (SELECT max_inserted_at FROM latest_insert) - INTERVAL 3 DAY
          AND toDate(block_time) < (SELECT latest_day FROM max_block_day)
    )
SELECT
    chain_id,
    day,
    uniq(address) as unique_addresses,
    now() as computed_at
FROM (
    -- Get all addresses for recently modified COMPLETE days
    SELECT 
        chain_id,
        toDate(block_time) as day,
        from as address
    FROM raw_traces
    WHERE toDate(block_time) IN (SELECT day FROM affected_days)
      AND from != unhex('0000000000000000000000000000000000000000')
    
    UNION ALL
    
    SELECT 
        chain_id,
        toDate(block_time) as day,
        to as address
    FROM raw_traces
    WHERE toDate(block_time) IN (SELECT day FROM affected_days)
      AND to IS NOT NULL
      AND to != unhex('0000000000000000000000000000000000000000')
)
GROUP BY chain_id, day;

-- ================================================
-- USAGE
-- ================================================
-- Direct query - pre-computed number:
-- SELECT unique_addresses 
-- FROM active_addresses_per_day 
-- WHERE chain_id = 1 AND day = '2024-01-01';

-- Get trend:
-- SELECT day, unique_addresses 
-- FROM active_addresses_per_day
-- WHERE chain_id = 1 AND day >= now() - INTERVAL 30 DAY
-- ORDER BY day;

-- Check freshness:
-- SELECT max(computed_at), max(day) 
-- FROM active_addresses_per_day;

-- ================================================
-- RECOVERY (if needed after crash)
-- ================================================
-- The MV will automatically recalculate on next refresh
-- To force immediate recalculation:
-- SYSTEM REFRESH VIEW mv_active_addresses_per_day;
