-- Target table for per-second transaction counts
-- This stores actual TPS data at second-level granularity
CREATE TABLE IF NOT EXISTS rollingWindowMetrics_tps_second (
    chain_id UInt32,
    second_bucket DateTime,
    tx_count UInt32
) ENGINE = SummingMergeTree()
ORDER BY (chain_id, second_bucket);

-- Materialized view that populates the table from raw_transactions
-- This triggers on inserts to raw_transactions and writes to the target table
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_rollingWindowMetrics_tps_second
TO rollingWindowMetrics_tps_second
AS
SELECT 
    chain_id,
    toStartOfSecond(block_time) AS second_bucket,
    toUInt32(COUNT(*)) as tx_count
FROM raw_transactions
GROUP BY chain_id, second_bucket;

-- Query examples:
-- Max TPS in last hour:
--   SELECT MAX(tx_count) as max_tps 
--   FROM rollingWindowMetrics_tps_second 
--   WHERE chain_id = 43114 AND second_bucket >= now() - INTERVAL 1 HOUR
--
-- Max TPS in last 24 hours:
--   SELECT MAX(tx_count) as max_tps 
--   FROM rollingWindowMetrics_tps_second 
--   WHERE chain_id = 43114 AND second_bucket >= now() - INTERVAL 1 DAY