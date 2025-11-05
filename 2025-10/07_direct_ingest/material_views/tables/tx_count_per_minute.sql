-- ================================================
-- TX COUNT PER MINUTE
-- ================================================
-- Computes transaction count per minute using refreshable MV
-- Excludes incomplete minutes for data consistency

-- Stats table with pre-computed counts
CREATE TABLE IF NOT EXISTS tx_count_per_minute (
    chain_id UInt32,
    minute DateTime,
    tx_count UInt64,
    computed_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (chain_id, minute);

-- Refreshable MV that recalculates every minute
-- Only processes COMPLETE minutes (excludes the latest blockchain minute)
-- Optimized to only recompute recent data (last 10 minutes by insertion time)
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_tx_count_per_minute
REFRESH EVERY 1 MINUTE
TO tx_count_per_minute
AS
WITH 
    latest_insert AS (
        -- Get the most recent insertion time
        SELECT max(inserted_at) as max_inserted_at
        FROM raw_transactions
    ),
    max_block_minute AS (
        -- Get the latest minute that has data (blockchain time, not wall time)
        SELECT toStartOfMinute(max(block_time)) as latest_minute
        FROM raw_transactions
        WHERE inserted_at >= (SELECT max_inserted_at FROM latest_insert) - INTERVAL 10 MINUTE
    ),
    affected_minutes AS (
        -- Find which minutes were recently modified (last 10 minutes of insertions)
        SELECT DISTINCT toStartOfMinute(block_time) as minute
        FROM raw_transactions
        WHERE inserted_at >= (SELECT max_inserted_at FROM latest_insert) - INTERVAL 10 MINUTE
          AND toStartOfMinute(block_time) < (SELECT latest_minute FROM max_block_minute)
    )
SELECT
    chain_id,
    toStartOfMinute(block_time) as minute,
    count(*) as tx_count,
    now() as computed_at
FROM raw_transactions
WHERE toStartOfMinute(block_time) IN (SELECT minute FROM affected_minutes)
GROUP BY chain_id, toStartOfMinute(block_time);

-- ================================================
-- USAGE
-- ================================================
-- Direct query - pre-computed number:
-- SELECT tx_count 
-- FROM tx_count_per_minute 
-- WHERE chain_id = 1 AND minute = '2024-01-01 12:30:00';

-- Get trend:
-- SELECT minute, tx_count 
-- FROM tx_count_per_minute
-- WHERE chain_id = 1 AND minute >= now() - INTERVAL 1 HOUR
-- ORDER BY minute;

-- Check freshness:
-- SELECT max(computed_at), max(minute) 
-- FROM tx_count_per_minute;

-- ================================================
-- RECOVERY (if needed after crash)
-- ================================================
-- The MV will automatically recalculate on next refresh
-- To force immediate recalculation:
-- SYSTEM REFRESH VIEW mv_tx_count_per_minute;
