-- Blocks table - main block headers
CREATE TABLE IF NOT EXISTS raw_blocks (
    chain_id UInt32,  -- Multiple chains in same tables
    block_number UInt32,
    hash FixedString(32),  -- 32 bytes
    parent_hash FixedString(32),
    block_time DateTime64(3),  -- Millisecond precision for Granite update
    miner FixedString(20),  -- 20 bytes address
    difficulty UInt8,  -- Always 1 on PoS chains
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
    mix_hash FixedString(32),
    nonce LowCardinality(FixedString(8)),  -- 8 bytes, always 0x00...00 on PoS
    sha3_uncles FixedString(32),
    uncles Array(FixedString(32)),
    blob_gas_used UInt32,  -- Always 0 if no blob txs
    excess_blob_gas UInt64,  -- Always 0 if no blob txs
    parent_beacon_block_root LowCardinality(FixedString(32))  -- Often all zeros
) ENGINE = MergeTree()
ORDER BY (chain_id, block_number)
PARTITION BY (chain_id, toYYYYMM(block_time));

-- Transactions table - merged with receipts for analytics performance
CREATE TABLE IF NOT EXISTS raw_transactions (
    chain_id UInt32,  -- Multiple chains in same tables
    hash FixedString(32),
    block_number UInt32,
    block_hash FixedString(32),
    block_time DateTime64(3),
    block_date Date MATERIALIZED toDate(block_time),  -- For partition pruning
    transaction_index UInt16,
    nonce UInt64,
    from FixedString(20),
    to Nullable(FixedString(20)),  -- NULL for contract creation
    value UInt256,
    gas_limit UInt32,  -- Renamed from 'gas' for clarity
    gas_price UInt64,
    gas_used UInt32,  -- From receipt
    success Bool,  -- From receipt status
    input String,  -- Calldata
    type UInt8,  -- 0,1,2,3 (legacy, EIP-2930, EIP-1559, EIP-4844)
    max_fee_per_gas Nullable(UInt64),  -- Only for EIP-1559
    max_priority_fee_per_gas Nullable(UInt64),  -- Only for EIP-1559
    priority_fee_per_gas Nullable(UInt64),  -- Computed: min(gas_price - base_fee, max_priority_fee)
    base_fee_per_gas UInt64,  -- Denormalized from blocks for easier queries
    contract_address Nullable(FixedString(20)),  -- From receipt if contract creation
    access_list Array(Tuple(
        address FixedString(20),
        storage_keys Array(FixedString(32))
    ))  -- Properly structured, not JSON
) ENGINE = MergeTree()
ORDER BY (chain_id, block_number, transaction_index)
PARTITION BY (chain_id, toYYYYMM(block_time));

-- Traces table - flattened trace calls
CREATE TABLE IF NOT EXISTS raw_traces (
    chain_id UInt32,  -- Multiple chains in same tables
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
ORDER BY (chain_id, block_number, transaction_index)
PARTITION BY (chain_id, toYYYYMM(block_time));

-- Logs table - event logs emitted by smart contracts
CREATE TABLE IF NOT EXISTS raw_logs (
    chain_id UInt32,  -- Multiple chains in same tables
    address FixedString(20),
    block_number UInt32,
    block_hash FixedString(32),  -- Needed for reorg detection and data integrity
    block_time DateTime64(3),
    block_date Date MATERIALIZED toDate(block_time),  -- For partition pruning
    transaction_hash FixedString(32),
    transaction_index UInt16,
    log_index UInt32,
    tx_from FixedString(20),  -- Denormalized from transactions for faster queries
    tx_to Nullable(FixedString(20)),  -- Denormalized from transactions
    topic0 FixedString(32),  -- Event signature hash (empty for rare anonymous events)
    topic1 Nullable(FixedString(32)),
    topic2 Nullable(FixedString(32)),
    topic3 Nullable(FixedString(32)),
    data String,  -- Non-indexed event data
    removed Bool  -- true if removed due to chain reorg
) ENGINE = MergeTree()
ORDER BY (chain_id, block_time, address, topic0)
PARTITION BY (chain_id, toYYYYMM(block_time));

-- Watermark table - tracks guaranteed sync progress per chain
CREATE TABLE IF NOT EXISTS sync_watermark (
    chain_id UInt32,
    block_number UInt32
) ENGINE = EmbeddedRocksDB
PRIMARY KEY chain_id;

