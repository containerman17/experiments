-- Target table for daily max TPS
-- Uses AggregatingMergeTree to store AggregateFunction state
CREATE TABLE IF NOT EXISTS rollingWindowMetrics_maxTps_daily (
    chain_id UInt32,
    day_bucket Date,
    max_tps AggregateFunction(max, UInt32)
) ENGINE = AggregatingMergeTree()
ORDER BY (chain_id, day_bucket);

-- Materialized view that cascades from maxTps_hourly TABLE (not the MV!)
-- This triggers on inserts to rollingWindowMetrics_maxTps_hourly table
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_rollingWindowMetrics_maxTps_daily
TO rollingWindowMetrics_maxTps_daily
AS
SELECT 
    chain_id,
    toDate(hour_bucket) AS day_bucket,
    maxMergeState(max_tps) as max_tps
FROM rollingWindowMetrics_maxTps_hourly  -- Reading from TABLE, not MV!
GROUP BY chain_id, day_bucket;

-- Query strategy for optimal performance:
-- - lastHour: query rollingWindowMetrics_tps_second (max 3,600 rows)
-- - lastDay: query rollingWindowMetrics_maxTps_hourly (max 24 rows)
-- - lastWeek: query rollingWindowMetrics_maxTps_hourly (max 168 rows) 
-- - lastMonth: query THIS daily aggregate table (max 30 rows)
-- - last90Days: query THIS daily aggregate table (max 90 rows)
-- - lastYear: query THIS daily aggregate table (max 365 rows)
-- - allTime: query THIS daily aggregate table (max ~1,825 rows for 5 years)

-- Query example for last 30 days:
--   SELECT maxMerge(max_tps) as max_tps
--   FROM rollingWindowMetrics_maxTps_daily
--   WHERE chain_id = 43114 AND day_bucket >= now() - INTERVAL 30 DAY