CREATE TABLE IF NOT EXISTS logs
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
    hash FixedString(66), -- TODO: change to 32 bytes
    parent_hash FixedString(66), -- TODO: change to 32 bytes
    miner FixedString(42), -- TODO: change to 20 bytes
    nonce FixedString(18), -- TODO: change to 8 bytes
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

-- Daily active addresses aggregation table
CREATE TABLE IF NOT EXISTS daily_active_addresses_agg
(
    block_date Date,
    addresses AggregateFunction(uniq, Nullable(FixedString(42)))
)
ENGINE = AggregatingMergeTree
ORDER BY block_date;

-- Materialized view for transactions addresses
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_transactions_addresses
TO daily_active_addresses_agg
AS
SELECT 
    block_date,
    uniqState(CAST(address AS Nullable(FixedString(42)))) as addresses
FROM (
    SELECT block_date, `from` as address FROM transactions
    UNION ALL
    SELECT block_date, `to` as address FROM transactions WHERE `to` IS NOT NULL
)
GROUP BY block_date;

-- Materialized view for traces addresses
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_traces_addresses
TO daily_active_addresses_agg
AS
SELECT 
    block_date,
    uniqState(CAST(address AS Nullable(FixedString(42)))) as addresses
FROM (
    SELECT block_date, `from` as address FROM traces
    UNION ALL
    SELECT block_date, `to` as address FROM traces WHERE `to` IS NOT NULL
)
GROUP BY block_date;

-- Materialized view for logs addresses
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_logs_addresses
TO daily_active_addresses_agg
AS
SELECT 
    block_date,
    uniqState(CAST(address AS Nullable(FixedString(42)))) as addresses
FROM (
    SELECT block_date, tx_from as address FROM logs
    UNION ALL
    SELECT block_date, tx_to as address FROM logs
)
GROUP BY block_date;

-- Query to get daily active addresses:
-- SELECT block_date, uniqMerge(addresses) as active_addresses
-- FROM daily_active_addresses_agg
-- GROUP BY block_date
-- ORDER BY block_date;

