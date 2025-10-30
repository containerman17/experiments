-- Materialized view for hourly max TPS
-- This aggregates per-second data into hourly max values
-- Used for efficient querying of longer time windows (day/week/month/year/allTime)
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_rollingWindowMetrics_maxTps_hourly
ENGINE = AggregatingMergeTree()
ORDER BY (chain_id, hour_bucket)
AS
SELECT 
    chain_id,
    toStartOfHour(second_bucket) AS hour_bucket,
    maxState(tx_count) as max_tps
FROM mv_rollingWindowMetrics_tps_second
GROUP BY chain_id, hour_bucket;

-- Query strategy:
-- - lastHour: query mv_rollingWindowMetrics_tps_second directly (3600 rows max)
-- - lastDay+: query this hourly aggregate (24-8760 rows max)
-- - allTime: query this hourly aggregate (all hours, but way fewer than all seconds)

-- Query examples:
-- Max TPS in last 24 hours (from hourly aggregates):
--   SELECT maxMerge(max_tps) as max_tps
--   FROM mv_rollingWindowMetrics_maxTps_hourly
--   WHERE chain_id = 43114 AND hour_bucket >= now() - INTERVAL 1 DAY
--
-- All-time max TPS (from hourly aggregates):
--   SELECT maxMerge(max_tps) as max_tps
--   FROM mv_rollingWindowMetrics_maxTps_hourly
--   WHERE chain_id = 43114

