-- Target table for hourly max TPS
-- Uses AggregatingMergeTree to store AggregateFunction state
CREATE TABLE IF NOT EXISTS rollingWindowMetrics_maxTps_hourly (
    chain_id UInt32,
    hour_bucket DateTime,
    max_tps AggregateFunction(max, UInt32)
) ENGINE = AggregatingMergeTree()
ORDER BY (chain_id, hour_bucket);

-- Materialized view that cascades from tps_second TABLE (not the MV!)
-- This triggers on inserts to rollingWindowMetrics_tps_second table
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_rollingWindowMetrics_maxTps_hourly
TO rollingWindowMetrics_maxTps_hourly
AS
SELECT 
    chain_id,
    toStartOfHour(second_bucket) AS hour_bucket,
    maxState(tx_count) as max_tps
FROM rollingWindowMetrics_tps_second  -- Reading from TABLE, not MV!
GROUP BY chain_id, hour_bucket;

-- Query strategy:
-- - lastHour: query rollingWindowMetrics_tps_second directly (3600 rows max)
-- - lastDay+: query this hourly aggregate table (24-8760 rows max)
-- - allTime: query this hourly aggregate table (all hours, but way fewer than all seconds)

-- Query examples:
-- Max TPS in last 24 hours (from hourly aggregates):
--   SELECT maxMerge(max_tps) as max_tps
--   FROM rollingWindowMetrics_maxTps_hourly
--   WHERE chain_id = 43114 AND hour_bucket >= now() - INTERVAL 1 DAY
--
-- All-time max TPS (from hourly aggregates):
--   SELECT maxMerge(max_tps) as max_tps
--   FROM rollingWindowMetrics_maxTps_hourly
--   WHERE chain_id = 43114