-- ================================================
-- ACTIVE ADDRESSES HOURLY - HISTORICAL BACKFILL
-- ================================================
-- One-time backfill to populate all historical data
-- Run this when first setting up or if you need to rebuild from scratch

-- Clear existing data (optional - uncomment if you want clean rebuild)
-- TRUNCATE TABLE active_addresses_hourly_stats;

-- Backfill all historical data
-- Note: Excluding the current/latest hour to avoid partial data
INSERT INTO active_addresses_hourly_stats (chain_id, hour, unique_addresses, computed_at)
WITH max_block_hour AS (
    -- Get the latest complete hour (exclude current hour)
    SELECT toStartOfHour(max(block_time)) as latest_hour
    FROM raw_traces
)
SELECT
    chain_id,
    toStartOfHour(block_time) as hour,
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
      AND toStartOfHour(block_time) < (SELECT latest_hour FROM max_block_hour)
    
    UNION ALL
    
    -- Get all TO addresses
    SELECT 
        chain_id,
        block_time,
        to as address
    FROM raw_traces
    WHERE to IS NOT NULL
      AND to != unhex('0000000000000000000000000000000000000000')
      AND toStartOfHour(block_time) < (SELECT latest_hour FROM max_block_hour)
)
GROUP BY chain_id, hour;

-- Optimize table to apply deduplication
OPTIMIZE TABLE active_addresses_hourly_stats FINAL;

-- Verify backfill results
SELECT 
    'Backfill Complete' as status,
    count(DISTINCT chain_id) as total_chains,
    count(*) as total_hour_records,
    min(hour) as earliest_hour,
    max(hour) as latest_hour,
    sum(unique_addresses) as total_unique_addresses_sum
FROM active_addresses_hourly_stats;
