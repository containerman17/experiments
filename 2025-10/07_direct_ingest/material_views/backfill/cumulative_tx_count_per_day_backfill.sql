-- ================================================
-- CUMULATIVE TX COUNT PER DAY - HISTORICAL BACKFILL
-- ================================================
-- One-time backfill to populate all historical data
-- Run this when first setting up or if you need to rebuild from scratch

-- Clear existing data (optional - uncomment if you want clean rebuild)
-- TRUNCATE TABLE cumulative_tx_count_per_day;

-- Backfill all historical data
-- Note: Excluding the current/latest day to avoid partial data
INSERT INTO cumulative_tx_count_per_day (chain_id, day, cumulative_tx_count, computed_at)
WITH 
    max_block_day AS (
        -- Get the latest complete day (exclude current day)
        SELECT toDate(max(block_time)) as latest_day
        FROM raw_transactions
    ),
    all_days AS (
        -- Get all unique chain-day combinations
        SELECT DISTINCT
            chain_id,
            toDate(block_time) as day
        FROM raw_transactions
        WHERE toDate(block_time) < (SELECT latest_day FROM max_block_day)
    )
-- Calculate cumulative count for each day using JOIN
SELECT 
    ad.chain_id,
    ad.day,
    count(rt.hash) as cumulative_tx_count,
    now() as computed_at
FROM all_days ad
LEFT JOIN raw_transactions rt ON 
    rt.chain_id = ad.chain_id
    AND toDate(rt.block_time) <= ad.day
GROUP BY ad.chain_id, ad.day;

-- Optimize table to apply deduplication
OPTIMIZE TABLE cumulative_tx_count_per_day FINAL;

-- Verify backfill results
SELECT 
    'Backfill Complete' as status,
    count(DISTINCT chain_id) as total_chains,
    count(*) as total_day_records,
    min(day) as earliest_day,
    max(day) as latest_day,
    max(cumulative_tx_count) as max_cumulative_count
FROM cumulative_tx_count_per_day;
