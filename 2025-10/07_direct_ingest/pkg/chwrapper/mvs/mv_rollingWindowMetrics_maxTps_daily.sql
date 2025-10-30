-- Materialized view for daily max TPS
-- This aggregates hourly max data into daily max values
-- Used for efficient querying of longer time windows (month/90days/year/allTime)
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_rollingWindowMetrics_maxTps_daily
ENGINE = AggregatingMergeTree()
ORDER BY (chain_id, day_bucket)
AS
SELECT 
    chain_id,
    toStartOfDay(hour_bucket) AS day_bucket,
    maxState(maxMerge(max_tps)) as max_tps
FROM mv_rollingWindowMetrics_maxTps_hourly
GROUP BY chain_id, day_bucket;

-- Query strategy for optimal performance:
-- - lastHour: query mv_rollingWindowMetrics_tps_second (max 3,600 rows)
-- - lastDay: query mv_rollingWindowMetrics_maxTps_hourly (max 24 rows)
-- - lastWeek: query mv_rollingWindowMetrics_maxTps_hourly (max 168 rows) 
-- - lastMonth: query THIS daily aggregate (max 30 rows)
-- - last90Days: query THIS daily aggregate (max 90 rows)
-- - lastYear: query THIS daily aggregate (max 365 rows)
-- - allTime: query THIS daily aggregate (max ~1,825 rows for 5 years)

-- Query example for last 30 days:
--   SELECT maxMerge(max_tps) as max_tps
--   FROM mv_rollingWindowMetrics_maxTps_daily
--   WHERE chain_id = 43114 AND day_bucket >= now() - INTERVAL 30 DAY
