CREATE TABLE IF NOT EXISTS transactions_by_hash
(
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
    )),  -- Properly structured, not JSON
    original_inserted_at DateTime64(3),  -- From raw_transactions, for tracking
    copied_at DateTime64(3) DEFAULT now64(3)  -- When copied to this table
)
ENGINE = EmbeddedRocksDB
PRIMARY KEY hash