-- Refreshable materialized view that pre-computes all rolling window maxTPS values
-- Refreshes every 5 minutes with the latest values
-- Uses the maximum block time from actual data (not wall clock) for backfilling scenarios
-- This trades real-time accuracy for extreme query performance

-- First create a regular table to store the pre-computed values
CREATE TABLE IF NOT EXISTS rollingWindowMetrics_maxTps_precomputed (
    chain_id UInt32,
    computed_at DateTime,
    last_hour UInt32,
    last_day UInt32,
    last_week UInt32,
    last_month UInt32,
    last_90_days UInt32,
    last_year UInt32,
    all_time UInt32
) ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (chain_id);

-- Refreshable materialized view that populates the table
-- This computes per-chain maxTPS values every 5 minutes
-- For "total" across all chains, we compute MAX at query time in the application
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_rollingWindowMetrics_maxTps_precomputed
REFRESH EVERY 1 MINUTE
TO rollingWindowMetrics_maxTps_precomputed
AS
SELECT
    chain_id,
    now() AS computed_at,  -- When this computation was done
    -- lastHour: query seconds TABLE directly relative to latest data time
    COALESCE(
        (SELECT MAX(tx_count) 
         FROM rollingWindowMetrics_tps_second s
         WHERE s.chain_id = chains.chain_id 
           AND s.second_bucket >= (SELECT MAX(block_time) FROM raw_blocks) - INTERVAL 1 HOUR
           AND s.second_bucket <= (SELECT MAX(block_time) FROM raw_blocks)), 
        0
    ) AS last_hour,
    
    -- lastDay: query hourly aggregates TABLE relative to latest data time
    COALESCE(
        (SELECT maxMerge(max_tps) 
         FROM rollingWindowMetrics_maxTps_hourly h
         WHERE h.chain_id = chains.chain_id 
           AND h.hour_bucket >= (SELECT MAX(block_time) FROM raw_blocks) - INTERVAL 1 DAY
           AND h.hour_bucket <= (SELECT MAX(block_time) FROM raw_blocks)), 
        0
    ) AS last_day,
    
    -- lastWeek: query hourly aggregates TABLE relative to latest data time
    COALESCE(
        (SELECT maxMerge(max_tps) 
         FROM rollingWindowMetrics_maxTps_hourly h
         WHERE h.chain_id = chains.chain_id 
           AND h.hour_bucket >= (SELECT MAX(block_time) FROM raw_blocks) - INTERVAL 7 DAY
           AND h.hour_bucket <= (SELECT MAX(block_time) FROM raw_blocks)), 
        0
    ) AS last_week,
    
    -- lastMonth: query daily aggregates TABLE relative to latest data time
    COALESCE(
        (SELECT maxMerge(max_tps) 
         FROM rollingWindowMetrics_maxTps_daily d
         WHERE d.chain_id = chains.chain_id 
           AND d.day_bucket >= (SELECT MAX(block_time) FROM raw_blocks) - INTERVAL 30 DAY
           AND d.day_bucket <= (SELECT MAX(block_time) FROM raw_blocks)), 
        0
    ) AS last_month,
    
    -- last90Days: query daily aggregates TABLE relative to latest data time
    COALESCE(
        (SELECT maxMerge(max_tps) 
         FROM rollingWindowMetrics_maxTps_daily d
         WHERE d.chain_id = chains.chain_id 
           AND d.day_bucket >= (SELECT MAX(block_time) FROM raw_blocks) - INTERVAL 90 DAY
           AND d.day_bucket <= (SELECT MAX(block_time) FROM raw_blocks)), 
        0
    ) AS last_90_days,
    
    -- lastYear: query daily aggregates TABLE relative to latest data time
    COALESCE(
        (SELECT maxMerge(max_tps) 
         FROM rollingWindowMetrics_maxTps_daily d
         WHERE d.chain_id = chains.chain_id 
           AND d.day_bucket >= (SELECT MAX(block_time) FROM raw_blocks) - INTERVAL 365 DAY
           AND d.day_bucket <= (SELECT MAX(block_time) FROM raw_blocks)), 
        0
    ) AS last_year,
    
    -- allTime: query daily aggregates TABLE (all available data)
    COALESCE(
        (SELECT maxMerge(max_tps) 
         FROM rollingWindowMetrics_maxTps_daily d
         WHERE d.chain_id = chains.chain_id), 
        0
    ) AS all_time
FROM (
    -- Get list of all chains that have data
    SELECT DISTINCT chain_id 
    FROM rollingWindowMetrics_tps_second
    WHERE chain_id != 0  -- Exclude any test/placeholder entries
) AS chains;

-- Query examples:
-- Single chain (lightning fast, single row lookup):
--   SELECT * FROM rollingWindowMetrics_maxTps_precomputed WHERE chain_id = 43114
--
-- Total across all chains (computed in application):
--   SELECT MAX(last_hour), MAX(last_day), ... FROM (
--     SELECT * FROM rollingWindowMetrics_maxTps_precomputed
--     ORDER BY chain_id, computed_at DESC
--     LIMIT 1 BY chain_id
--   )