-- Materialized view for active addresses from transactions
-- Triggered by inserts to raw_transactions
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_metrics_activeAddresses_transactions
ENGINE = ReplacingMergeTree()
ORDER BY (chain_id, hour_bucket, address)
POPULATE
AS
SELECT DISTINCT
    chain_id,
    toStartOfHour(block_time) AS hour_bucket,
    address
FROM (
    -- Transaction from addresses
    SELECT chain_id, block_time, from AS address
    FROM raw_transactions
    WHERE from != unhex('0000000000000000000000000000000000000000')
    
    UNION ALL
    
    -- Transaction to addresses (excluding contract creation)
    SELECT chain_id, block_time, assumeNotNull(to) AS address
    FROM raw_transactions
    WHERE to IS NOT NULL 
      AND to != unhex('0000000000000000000000000000000000000000')
);
