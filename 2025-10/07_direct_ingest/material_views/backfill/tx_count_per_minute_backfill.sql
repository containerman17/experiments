-- ================================================
-- TX COUNT PER MINUTE - HISTORICAL BACKFILL
-- ================================================
-- One-time backfill to populate all historical data
-- Run this when first setting up or if you need to rebuild from scratch

-- Clear existing data (optional - uncomment if you want clean rebuild)
-- TRUNCATE TABLE tx_count_per_minute;

-- Backfill all historical data
-- Note: Excluding the current/latest minute to avoid partial data
INSERT INTO tx_count_per_minute (chain_id, minute, tx_count, computed_at)
WITH max_block_minute AS (
    -- Get the latest complete minute (exclude current minute)
    SELECT toStartOfMinute(max(block_time)) as latest_minute
    FROM raw_transactions
)
SELECT
    chain_id,
    toStartOfMinute(block_time) as minute,
    count(*) as tx_count,
    now() as computed_at
FROM raw_transactions
WHERE toStartOfMinute(block_time) < (SELECT latest_minute FROM max_block_minute)
GROUP BY chain_id, minute;

-- Optimize table to apply deduplication
OPTIMIZE TABLE tx_count_per_minute FINAL;

-- Verify backfill results
SELECT 
    'Backfill Complete' as status,
    count(DISTINCT chain_id) as total_chains,
    count(*) as total_minute_records,
    min(minute) as earliest_minute,
    max(minute) as latest_minute,
    sum(tx_count) as total_transactions
FROM tx_count_per_minute;
