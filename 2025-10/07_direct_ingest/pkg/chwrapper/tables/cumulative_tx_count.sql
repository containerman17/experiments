-- ================================================
-- CUMULATIVE TX COUNT
-- ================================================
-- Computes total cumulative transaction count up to each day
-- Uses direct COUNT(*) which is extremely fast in ClickHouse

-- Stats table with cumulative counts
CREATE TABLE IF NOT EXISTS cumulative_tx_count (
    chain_id UInt32,
    day Date,
    cumulative_tx_count UInt64,
    computed_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (chain_id, day);

-- Refreshable MV that recalculates daily
-- Only processes COMPLETE days (excludes the latest blockchain day)
-- Recomputes cumulative for recently modified days
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_cumulative_tx_count
REFRESH EVERY 1 DAY
TO cumulative_tx_count
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
    earliest_affected_day AS (
        -- Find the earliest day that had recent insertions
        SELECT 
            chain_id,
            min(toDate(block_time)) as min_day
        FROM raw_transactions
        WHERE inserted_at >= (SELECT max_inserted_at FROM latest_insert) - INTERVAL 3 DAY
        GROUP BY chain_id
    ),
    affected_days AS (
        -- Get all days from earliest affected to latest complete day
        -- This ensures cumulative counts are updated for all impacted days
        SELECT DISTINCT
            rt.chain_id,
            toDate(rt.block_time) as day
        FROM raw_transactions rt
        INNER JOIN earliest_affected_day ead
            ON rt.chain_id = ead.chain_id
        WHERE toDate(rt.block_time) >= ead.min_day
          AND toDate(rt.block_time) < (SELECT latest_day FROM max_block_day)
    )
-- Calculate cumulative count for each affected day using JOIN
SELECT 
    ad.chain_id,
    ad.day,
    count(rt.hash) as cumulative_tx_count,
    now() as computed_at
FROM affected_days ad
LEFT JOIN raw_transactions rt ON 
    rt.chain_id = ad.chain_id
    AND toDate(rt.block_time) <= ad.day
GROUP BY ad.chain_id, ad.day;

-- ================================================
-- USAGE
-- ================================================
-- Get cumulative count for specific day:
-- SELECT cumulative_tx_count 
-- FROM cumulative_tx_count 
-- WHERE chain_id = 1 AND day = '2024-01-01';

-- Get growth trend:
-- SELECT 
--     day, 
--     cumulative_tx_count,
--     cumulative_tx_count - lag(cumulative_tx_count) OVER (ORDER BY day) as daily_increase
-- FROM cumulative_tx_count
-- WHERE chain_id = 1 AND day >= now() - INTERVAL 30 DAY
-- ORDER BY day;

-- Total transactions as of latest day:
-- SELECT max(cumulative_tx_count) as total_transactions
-- FROM cumulative_tx_count
-- WHERE chain_id = 1;

-- ================================================
-- RECOVERY (if needed after crash)
-- ================================================
-- The MV will automatically recalculate on next refresh
-- To force immediate recalculation:
-- SYSTEM REFRESH VIEW mv_cumulative_tx_count;
