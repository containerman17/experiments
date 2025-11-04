-- ================================================
-- MAX TPS PER HOUR - HISTORICAL BACKFILL
-- ================================================
-- One-time backfill to populate all historical data
-- Run this when first setting up or if you need to rebuild from scratch

-- Clear existing data (optional - uncomment if you want clean rebuild)
-- TRUNCATE TABLE max_tps_per_hour;

-- Backfill all historical data
-- Note: Excluding the current/latest hour to avoid partial data
INSERT INTO max_tps_per_hour (chain_id, hour, max_tps, computed_at)
WITH 
    max_block_hour AS (
        -- Get the latest complete hour (exclude current hour)
        SELECT toStartOfHour(max(block_time)) as latest_hour
        FROM raw_transactions
    ),
    tps_by_second AS (
        -- First level: count transactions per second
        SELECT 
            chain_id,
            toStartOfHour(block_time) as hour,
            toStartOfSecond(block_time) as second,
            count(*) as tx_per_second
        FROM raw_transactions
        WHERE toStartOfHour(block_time) < (SELECT latest_hour FROM max_block_hour)
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

-- Optimize table to apply deduplication
OPTIMIZE TABLE max_tps_per_hour FINAL;

-- Verify backfill results
SELECT 
    'Backfill Complete' as status,
    count(DISTINCT chain_id) as total_chains,
    count(*) as total_hour_records,
    min(hour) as earliest_hour,
    max(hour) as latest_hour,
    max(max_tps) as highest_tps_observed
FROM max_tps_per_hour;
