-- Materialized view for hourly transaction counts
-- Triggered by inserts to raw_transactions
-- Uses SummingMergeTree to automatically sum counts for the same hour
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_metrics_txCount_hourly
ENGINE = SummingMergeTree()
ORDER BY (chain_id, hour_bucket)
POPULATE
AS
SELECT 
    chain_id,
    toStartOfHour(block_time) AS hour_bucket,
    toUInt64(COUNT(*)) as tx_count
FROM raw_transactions
GROUP BY chain_id, hour_bucket;

-- This MV will automatically sum tx_count values for the same (chain_id, hour_bucket)
-- when multiple inserts happen for the same hour

-- Query examples:
-- Regular txCount by hour:
--   SELECT hour_bucket, SUM(tx_count) as value 
--   FROM mv_metrics_txCount_hourly 
--   WHERE chain_id = 43114 AND hour_bucket >= '2021-01-01' 
--   GROUP BY hour_bucket
--
-- Cumulative txCount:
--   SELECT 
--     hour_bucket,
--     SUM(SUM(tx_count)) OVER (ORDER BY hour_bucket) as cumulative_count
--   FROM mv_metrics_txCount_hourly  
--   WHERE chain_id = 43114
--   GROUP BY hour_bucket
