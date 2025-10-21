CREATE TABLE logs
(
    block_time DateTime64(3),
    block_number UInt64,
    block_hash FixedString(66),
    contract_address FixedString(42),
    topic0 FixedString(66),
    topic1 FixedString(66),
    topic2 FixedString(66),
    topic3 FixedString(66),
    data String,
    tx_hash FixedString(66),
    log_index UInt32,
    tx_index UInt32,
    block_date Date,
    tx_from FixedString(42),
    tx_to FixedString(42)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(block_time)
ORDER BY (block_time, block_number, tx_index, log_index);


