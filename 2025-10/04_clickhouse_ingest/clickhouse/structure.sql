CREATE TABLE logs
(
    block_time DateTime64(3),
    block_number UInt32,
    block_hash FixedString(66), -- TODO: change to 32 bytes
    contract_address FixedString(42), -- TODO: change to 20 bytes  
    topic0 FixedString(66), -- TODO: change to 32 bytes
    topic1 FixedString(66), -- TODO: change to 32 bytes
    topic2 FixedString(66), -- TODO: change to 32 bytes
    topic3 FixedString(66), -- TODO: change to 32 bytes
    data String,
    tx_hash FixedString(66), -- TODO: change to 32 bytes
    log_index UInt16,
    tx_index UInt16,
    block_date Date,
    tx_from FixedString(42), -- TODO: change to 20 bytes
    tx_to FixedString(42), -- TODO: change to 20 bytes
    INDEX idx_topic0 topic0 TYPE set(0) GRANULARITY 1,
    INDEX idx_topic1 topic1 TYPE set(0) GRANULARITY 1,
    INDEX idx_topic2 topic2 TYPE set(0) GRANULARITY 1,
    INDEX idx_topic3 topic3 TYPE set(0) GRANULARITY 1,
    INDEX idx_to tx_to TYPE set(0) GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(block_time)
ORDER BY (contract_address, topic0, block_number, topic1);

CREATE TABLE blocks
(
    time DateTime,
    timestamp UInt32,
    number UInt32,
    gas_limit UInt64,
    gas_used UInt64,
    difficulty UInt32,
    total_difficulty UInt32,
    size UInt32,
    base_fee_per_gas Nullable(UInt64),
    hash FixedString(66), -- TODO: change to 32 bytes
    parent_hash FixedString(66), -- TODO: change to 32 bytes
    miner FixedString(42), -- TODO: change to 20 bytes
    nonce FixedString(18), -- TODO: change to 8 bytes
    date Date
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(time)
ORDER BY (number);


