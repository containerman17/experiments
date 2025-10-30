-- Materialized view for active senders from transactions
-- Triggered by inserts to raw_transactions
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_metrics_activeSenders_transactions
ENGINE = ReplacingMergeTree()
ORDER BY (chain_id, hour_bucket, address)
AS
SELECT DISTINCT
    chain_id,
    toStartOfHour(block_time) AS hour_bucket,
    from AS address
FROM raw_transactions
WHERE from != unhex('0000000000000000000000000000000000000000');

