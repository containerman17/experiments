-- ================================================
-- TX COUNT PER DAY
-- ================================================
-- Computes transaction count per day using refreshable MV
-- Excludes incomplete days for data consistency

-- Stats table with pre-computed counts
CREATE TABLE IF NOT EXISTS tx_count_per_day (
    chain_id UInt32,
    day Date,
    tx_count UInt64,
    computed_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (chain_id, day);

-- Refreshable MV that recalculates every hour
-- Only processes COMPLETE days (excludes the latest blockchain day)
-- Optimized to only recompute recent data (last 3 days by insertion time)
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_tx_count_per_day
REFRESH EVERY 1 HOUR
TO tx_count_per_day
AS
WITH 
    latest_insert AS (
        -- Get the most recent insertion time
        SELECT max(inserted_at) as max_inserted_at
        FROM raw_transactions
    ),
    max_block_day AS (
        -- Get the latest day that has data (blockchain time, not wall time)
        SELECT toDate(max(block_time)) as latest_day
        FROM raw_transactions
        WHERE inserted_at >= (SELECT max_inserted_at FROM latest_insert) - INTERVAL 3 DAY
    ),
    affected_days AS (
        -- Find which days were recently modified (last 3 days of insertions)
        SELECT DISTINCT toDate(block_time) as day
        FROM raw_transactions
        WHERE inserted_at >= (SELECT max_inserted_at FROM latest_insert) - INTERVAL 3 DAY
          AND toDate(block_time) < (SELECT latest_day FROM max_block_day)
    )
SELECT
    chain_id,
    toDate(block_time) as day,
    count(*) as tx_count,
    now() as computed_at
FROM raw_transactions
WHERE toDate(block_time) IN (SELECT day FROM affected_days)
GROUP BY chain_id, toDate(block_time);

-- ================================================
-- USAGE
-- ================================================
-- Direct query - pre-computed number:
-- SELECT tx_count 
-- FROM tx_count_per_day 
-- WHERE chain_id = 1 AND day = '2024-01-01';

-- Get trend:
-- SELECT day, tx_count 
-- FROM tx_count_per_day
-- WHERE chain_id = 1 AND day >= now() - INTERVAL 30 DAY
-- ORDER BY day;

-- Check freshness:
-- SELECT max(computed_at), max(day) 
-- FROM tx_count_per_day;

-- ================================================
-- RECOVERY (if needed after crash)
-- ================================================
-- The MV will automatically recalculate on next refresh
-- To force immediate recalculation:
-- SYSTEM REFRESH VIEW mv_tx_count_per_day;
