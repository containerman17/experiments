-- ================================================
-- MAX TPS PER HOUR
-- ================================================
-- Computes maximum transactions per second within each hour
-- Uses nested aggregation: count per second, then max per hour

-- Stats table with pre-computed max TPS values
CREATE TABLE IF NOT EXISTS max_tps_per_hour (
    chain_id UInt32,
    hour DateTime,
    max_tps UInt64,
    computed_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (chain_id, hour);

-- Refreshable MV that recalculates every hour
-- Only processes COMPLETE hours (excludes the latest blockchain hour)
-- Optimized to only recompute recent data (last 3 hours by insertion time)
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_max_tps_per_hour
REFRESH EVERY 1 HOUR
TO max_tps_per_hour
AS
WITH 
    latest_insert AS (
        -- Get the most recent insertion time
        SELECT max(inserted_at) as max_inserted_at
        FROM raw_transactions
    ),
    max_block_hour AS (
        -- Get the latest hour that has data (blockchain time, not wall time)
        SELECT toStartOfHour(max(block_time)) as latest_hour
        FROM raw_transactions
        WHERE inserted_at >= (SELECT max_inserted_at FROM latest_insert) - INTERVAL 3 HOUR
    ),
    affected_hours AS (
        -- Find which hours were recently modified (last 3 hours of insertions)
        SELECT DISTINCT toStartOfHour(block_time) as hour
        FROM raw_transactions
        WHERE inserted_at >= (SELECT max_inserted_at FROM latest_insert) - INTERVAL 3 HOUR
          AND toStartOfHour(block_time) < (SELECT latest_hour FROM max_block_hour)
    ),
    tps_by_second AS (
        -- First level: count transactions per second
        SELECT 
            chain_id,
            toStartOfHour(block_time) as hour,
            toStartOfSecond(block_time) as second,
            count(*) as tx_per_second
        FROM raw_transactions
        WHERE toStartOfHour(block_time) IN (SELECT hour FROM affected_hours)
        GROUP BY chain_id, toStartOfHour(block_time), toStartOfSecond(block_time)
    )
-- Second level: find max TPS within each hour
SELECT
    chain_id,
    hour,
    max(tx_per_second) as max_tps,
    now() as computed_at
FROM tps_by_second
GROUP BY chain_id, hour;

-- ================================================
-- USAGE
-- ================================================
-- Direct query - pre-computed max TPS:
-- SELECT max_tps 
-- FROM max_tps_per_hour 
-- WHERE chain_id = 1 AND hour = '2024-01-01 12:00:00';

-- Get trend:
-- SELECT hour, max_tps 
-- FROM max_tps_per_hour
-- WHERE chain_id = 1 AND hour >= now() - INTERVAL 24 HOUR
-- ORDER BY hour;

-- Peak TPS across all hours:
-- SELECT max(max_tps) as all_time_max_tps
-- FROM max_tps_per_hour
-- WHERE chain_id = 1;

-- ================================================
-- RECOVERY (if needed after crash)
-- ================================================
-- The MV will automatically recalculate on next refresh
-- To force immediate recalculation:
-- SYSTEM REFRESH VIEW mv_max_tps_per_hour;
