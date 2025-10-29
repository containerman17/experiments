-- Blocks table - main block headers
CREATE TABLE IF NOT EXISTS blocks (
    block_number UInt32,
    hash FixedString(32),  -- 32 bytes
    parent_hash FixedString(32),
    block_time DateTime64(3),  -- Millisecond precision for Granite update
    miner FixedString(20),  -- 20 bytes address
    difficulty LowCardinality(UInt8),  -- Always 1 on PoS chains
    total_difficulty UInt64,  -- On PoS chains, equals block number, but store for compatibility
    size UInt32,
    gas_limit UInt32,
    gas_used UInt32,
    base_fee_per_gas UInt64,
    block_gas_cost UInt64,
    state_root FixedString(32),
    transactions_root FixedString(32),
    receipts_root FixedString(32),
    extra_data String,
    block_extra_data String,
    ext_data_hash FixedString(32),
    ext_data_gas_used UInt32,
    logs_bloom FixedString(256),  -- 256 bytes bloom filter
    mix_hash FixedString(32),
    nonce LowCardinality(FixedString(8)),  -- 8 bytes, always 0x00...00 on PoS
    sha3_uncles FixedString(32),
    uncles Array(FixedString(32)),
    blob_gas_used LowCardinality(UInt32),  -- Always 0 if no blob txs
    excess_blob_gas LowCardinality(UInt64),  -- Always 0 if no blob txs
    parent_beacon_block_root LowCardinality(FixedString(32))  -- Often all zeros
) ENGINE = MergeTree()
ORDER BY block_number
PARTITION BY toYYYYMM(block_time);

-- Transactions table
CREATE TABLE IF NOT EXISTS transactions (
    hash FixedString(32),
    block_number UInt32,
    block_hash FixedString(32),
    block_time DateTime64(3),
    transaction_index UInt16,
    nonce UInt64,
    from FixedString(20),
    to Nullable(FixedString(20)),  -- NULL for contract creation
    value UInt256,
    gas UInt32,
    gas_price UInt64,
    input String,  -- Calldata
    v UInt8,
    r FixedString(32),
    s FixedString(32),
    y_parity Nullable(UInt8),  -- Only for EIP-1559 txs
    type LowCardinality(UInt8),  -- 0,1,2,3 (legacy, EIP-2930, EIP-1559, EIP-4844)
    chain_id UInt32,
    max_fee_per_gas Nullable(UInt64),  -- Only for EIP-1559
    max_priority_fee_per_gas Nullable(UInt64),  -- Only for EIP-1559
    access_list String  -- JSON array, usually small
) ENGINE = MergeTree()
ORDER BY (block_number, transaction_index)
PARTITION BY toYYYYMM(block_time);

-- Traces table - flattened trace calls
CREATE TABLE IF NOT EXISTS traces (
    tx_hash FixedString(32),
    block_number UInt32,
    block_time DateTime64(3),
    transaction_index UInt16,
    trace_address Array(UInt16),  -- Path in call tree, e.g. [0,2,1] = first call -> third subcall -> second subcall
    from FixedString(20),
    to Nullable(FixedString(20)),  -- NULL for certain call types
    gas UInt32,
    gas_used UInt32,
    value UInt256,
    input String,
    output String,
    call_type LowCardinality(String)  -- CALL, DELEGATECALL, STATICCALL, CREATE, CREATE2, etc.
) ENGINE = MergeTree()
ORDER BY (block_number, transaction_index, trace_address)
PARTITION BY toYYYYMM(block_time);

-- Receipts table - transaction execution results
CREATE TABLE IF NOT EXISTS receipts (
    transaction_hash FixedString(32),
    block_number UInt32,
    block_hash FixedString(32),
    block_time DateTime64(3),
    transaction_index UInt16,
    contract_address Nullable(FixedString(20)),  -- NULL if not contract creation
    cumulative_gas_used UInt32,
    effective_gas_price UInt64,
    from FixedString(20),
    gas_used UInt32,
    logs_bloom FixedString(256),
    status LowCardinality(UInt8),  -- 0 = failure, 1 = success
    to Nullable(FixedString(20)),
    type LowCardinality(UInt8)
) ENGINE = MergeTree()
ORDER BY (block_number, transaction_index)
PARTITION BY toYYYYMM(block_time);

-- Logs table - event logs emitted by smart contracts
CREATE TABLE IF NOT EXISTS logs (
    address FixedString(20),
    block_number UInt32,
    -- Even though the original RPC does provide a block hash, I dont see any use for it
    -- block_hash FixedString(32),
    block_time DateTime64(3),
    transaction_hash FixedString(32),
    transaction_index UInt16,
    log_index UInt32,
    topic0 Nullable(FixedString(32)),  -- Indexed event signature
    topic1 Nullable(FixedString(32)),
    topic2 Nullable(FixedString(32)),
    topic3 Nullable(FixedString(32)),
    data String,  -- Non-indexed event data
    removed Bool  -- true if removed due to chain reorg
) ENGINE = MergeTree()
ORDER BY (block_time, address, topic0)
PARTITION BY toYYYYMM(block_time);

-- Watermark table - tracks guaranteed sync progress
CREATE TABLE IF NOT EXISTS watermark (
    id UInt8,
    block_number UInt32
) ENGINE = EmbeddedRocksDB
PRIMARY KEY id;

