-- ================================================
-- TX COUNT PER DAY - HISTORICAL BACKFILL
-- ================================================
-- One-time backfill to populate all historical data
-- Run this when first setting up or if you need to rebuild from scratch

-- Clear existing data (optional - uncomment if you want clean rebuild)
-- TRUNCATE TABLE tx_count_per_day;

-- Backfill all historical data
-- Note: Excluding the current/latest day to avoid partial data
INSERT INTO tx_count_per_day (chain_id, day, tx_count, computed_at)
WITH max_block_day AS (
    -- Get the latest complete day (exclude current day)
    SELECT toDate(max(block_time)) as latest_day
    FROM raw_transactions
)
SELECT
    chain_id,
    toDate(block_time) as day,
    count(*) as tx_count,
    now() as computed_at
FROM raw_transactions
WHERE toDate(block_time) < (SELECT latest_day FROM max_block_day)
GROUP BY chain_id, day;

-- Optimize table to apply deduplication
OPTIMIZE TABLE tx_count_per_day FINAL;

-- Verify backfill results
SELECT 
    'Backfill Complete' as status,
    count(DISTINCT chain_id) as total_chains,
    count(*) as total_day_records,
    min(day) as earliest_day,
    max(day) as latest_day,
    sum(tx_count) as total_transactions
FROM tx_count_per_day;
