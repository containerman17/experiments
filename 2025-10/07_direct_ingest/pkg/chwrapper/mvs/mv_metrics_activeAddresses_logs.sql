-- Materialized view for active addresses from token transfers in logs
-- Triggered by inserts to raw_logs
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_metrics_activeAddresses_logs
ENGINE = ReplacingMergeTree()
ORDER BY (chain_id, hour_bucket, address)
AS
WITH 
    -- ERC20/721 Transfer signature
    transfer_sig AS (SELECT unhex('ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') AS sig),
    -- ERC1155 TransferSingle signature  
    transfer_single_sig AS (SELECT unhex('c3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62') AS sig),
    -- ERC1155 TransferBatch signature
    transfer_batch_sig AS (SELECT unhex('4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb') AS sig)
SELECT DISTINCT
    chain_id,
    toStartOfHour(block_time) AS hour_bucket,
    address
FROM (
    -- ERC20/ERC721 Transfer from addresses (topic1)
    SELECT chain_id, block_time, assumeNotNull(substr(topic1, 13, 20)) AS address
    FROM raw_logs, transfer_sig
    WHERE topic0 = transfer_sig.sig
      AND topic1 IS NOT NULL
      AND substr(topic1, 13, 20) != unhex('0000000000000000000000000000000000000000')
    
    UNION ALL
    
    -- ERC20/ERC721 Transfer to addresses (topic2)
    SELECT chain_id, block_time, assumeNotNull(substr(topic2, 13, 20)) AS address
    FROM raw_logs, transfer_sig
    WHERE topic0 = transfer_sig.sig
      AND topic2 IS NOT NULL
      AND substr(topic2, 13, 20) != unhex('0000000000000000000000000000000000000000')
    
    UNION ALL
    
    -- ERC1155 TransferSingle from addresses (topic2)
    SELECT chain_id, block_time, assumeNotNull(substr(topic2, 13, 20)) AS address
    FROM raw_logs, transfer_single_sig
    WHERE topic0 = transfer_single_sig.sig
      AND topic2 IS NOT NULL
      AND substr(topic2, 13, 20) != unhex('0000000000000000000000000000000000000000')
    
    UNION ALL
    
    -- ERC1155 TransferSingle to addresses (topic3)
    SELECT chain_id, block_time, assumeNotNull(substr(topic3, 13, 20)) AS address
    FROM raw_logs, transfer_single_sig
    WHERE topic0 = transfer_single_sig.sig
      AND topic3 IS NOT NULL
      AND substr(topic3, 13, 20) != unhex('0000000000000000000000000000000000000000')
    
    UNION ALL
    
    -- ERC1155 TransferBatch from addresses (topic2)
    SELECT chain_id, block_time, assumeNotNull(substr(topic2, 13, 20)) AS address
    FROM raw_logs, transfer_batch_sig
    WHERE topic0 = transfer_batch_sig.sig
      AND topic2 IS NOT NULL
      AND substr(topic2, 13, 20) != unhex('0000000000000000000000000000000000000000')
    
    UNION ALL
    
    -- ERC1155 TransferBatch to addresses (topic3)
    SELECT chain_id, block_time, assumeNotNull(substr(topic3, 13, 20)) AS address
    FROM raw_logs, transfer_batch_sig
    WHERE topic0 = transfer_batch_sig.sig
      AND topic3 IS NOT NULL
      AND substr(topic3, 13, 20) != unhex('0000000000000000000000000000000000000000')
);
