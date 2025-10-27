CREATE MATERIALIZED VIEW IF NOT EXISTS usdc_transfers
(
    block_time DateTime64(3),
    block_number UInt32,
    block_hash FixedString(66),
    contract_address FixedString(42),
    topic0 FixedString(66),
    `from` FixedString(66),
    `to` FixedString(66),
    value FixedString(66),
    data String,
    tx_hash FixedString(66),
    log_index UInt16,
    tx_index UInt16,
    block_date Date,
    tx_from FixedString(42),
    tx_to FixedString(42)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(block_time)
ORDER BY (block_number, log_index)
AS
SELECT 
    block_time,
    block_number,
    block_hash,
    contract_address,
    topic0,
    topic1 as `from`,
    topic2 as `to`,
    topic3 as value,
    data,
    tx_hash,
    log_index,
    tx_index,
    block_date,
    tx_from,
    tx_to
FROM logs
WHERE contract_address = '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e'
  AND topic0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'