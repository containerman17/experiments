CREATE TABLE IF NOT EXISTS logs
(
    block_time DateTime64(3),
    block_number UInt32,
    block_hash FixedString(66), 
    contract_address FixedString(42),   
    topic0 FixedString(66), 
    topic1 FixedString(66), 
    topic2 FixedString(66), 
    data String,
    tx_hash FixedString(66), 
    log_index UInt16,
    tx_index UInt16,
    block_date Date,
    tx_from FixedString(42), 
    tx_to FixedString(42), 
    INDEX idx_topic0 topic0 TYPE set(0) GRANULARITY 1,
    INDEX idx_topic1 topic1 TYPE set(0) GRANULARITY 1,
    INDEX idx_topic2 topic2 TYPE set(0) GRANULARITY 1,
    INDEX idx_to tx_to TYPE set(0) GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(block_time)
ORDER BY (contract_address, topic0, block_number, topic1);

CREATE TABLE IF NOT EXISTS blocks
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
    hash FixedString(66), 
    parent_hash FixedString(66), 
    miner FixedString(42), 
    nonce FixedString(18), -- FIXME: is it a number?
    date Date
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(time)
ORDER BY (number);

CREATE TABLE IF NOT EXISTS transactions
(
    block_time DateTime,
    block_number UInt32,
    value UInt256,
    gas_limit UInt64,
    gas_price UInt64,
    gas_used UInt64,
    max_fee_per_gas Nullable(UInt64),
    max_priority_fee_per_gas Nullable(UInt64),
    priority_fee_per_gas Nullable(UInt64),
    nonce UInt64,
    `index` UInt16,
    success UInt8,
    `from` FixedString(42),
    `to` Nullable(FixedString(42)),
    block_hash FixedString(66),
    `data` String,
    `hash` FixedString(66),
    `type` UInt8,
    access_list Array(Tuple(FixedString(42), Array(FixedString(66)))),
    block_date Date
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(block_time)
ORDER BY (block_number, `index`);

CREATE TABLE IF NOT EXISTS traces
(
    block_time DateTime,
    block_number UInt32,
    value UInt256,
    gas UInt64,
    gas_used UInt64,
    net_gas_used UInt64,
    block_hash FixedString(66),
    success UInt8,
    tx_index UInt16,
    sub_traces UInt32,
    error Nullable(String),
    tx_success UInt8,
    tx_hash FixedString(66),
    `from` FixedString(42),
    `to` Nullable(FixedString(42)),
    trace_address Array(UInt16),
    `type` LowCardinality(String),
    `address` Nullable(FixedString(42)),
    code Nullable(String),
    call_type LowCardinality(Nullable(String)),
    `input` String,
    output Nullable(String),
    refund_address Nullable(FixedString(42)),
    block_date Date
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(block_time)
ORDER BY (block_number, tx_index, trace_address);
