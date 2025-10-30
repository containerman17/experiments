-- Materialized view for per-second transaction counts
-- This is used for rolling window maxTPS calculations
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_rollingWindowMetrics_tps_second
ENGINE = SummingMergeTree()
ORDER BY (chain_id, second_bucket)
AS
SELECT 
    chain_id,
    toStartOfSecond(block_time) AS second_bucket,
    toUInt32(COUNT(*)) as tx_count
FROM raw_transactions
GROUP BY chain_id, second_bucket;

-- This gives us actual TPS data at second-level granularity
-- For maxTPS queries, we find the MAX(tx_count) over different time windows

-- Query examples:
-- Max TPS in last hour:
--   SELECT MAX(tx_count) as max_tps 
--   FROM mv_rollingWindowMetrics_tps_second 
--   WHERE chain_id = 43114 AND second_bucket >= now() - INTERVAL 1 HOUR
--
-- Max TPS in last 24 hours:
--   SELECT MAX(tx_count) as max_tps 
--   FROM mv_rollingWindowMetrics_tps_second 
--   WHERE chain_id = 43114 AND second_bucket >= now() - INTERVAL 1 DAY
