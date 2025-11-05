-- ================================================
-- ACTIVE ADDRESSES PER DAY - HISTORICAL BACKFILL
-- ================================================
-- One-time backfill to populate all historical data
-- Run this when first setting up or if you need to rebuild from scratch

-- Clear existing data (optional - uncomment if you want clean rebuild)
-- TRUNCATE TABLE active_addresses_per_day;

-- Backfill all historical data
-- Note: Excluding the current/latest day to avoid partial data
INSERT INTO active_addresses_per_day (chain_id, day, unique_addresses, computed_at)
WITH max_block_day AS (
    -- Get the latest complete day (exclude current day)
    SELECT toDate(max(block_time)) as latest_day
    FROM raw_traces
)
SELECT
    chain_id,
    toDate(block_time) as day,
    uniq(address) as unique_addresses,
    now() as computed_at
FROM (
    -- Get all FROM addresses
    SELECT 
        chain_id,
        block_time,
        from as address
    FROM raw_traces
    WHERE from != unhex('0000000000000000000000000000000000000000')
      AND toDate(block_time) < (SELECT latest_day FROM max_block_day)
    
    UNION ALL
    
    -- Get all TO addresses
    SELECT 
        chain_id,
        block_time,
        to as address
    FROM raw_traces
    WHERE to IS NOT NULL
      AND to != unhex('0000000000000000000000000000000000000000')
      AND toDate(block_time) < (SELECT latest_day FROM max_block_day)
)
GROUP BY chain_id, day;

-- Optimize table to apply deduplication
OPTIMIZE TABLE active_addresses_per_day FINAL;

-- Verify backfill results
SELECT 
    'Backfill Complete' as status,
    count(DISTINCT chain_id) as total_chains,
    count(*) as total_day_records,
    min(day) as earliest_day,
    max(day) as latest_day,
    sum(unique_addresses) as total_unique_addresses_sum
FROM active_addresses_per_day;
