CREATE TABLE IF NOT EXISTS traces (
    -- Transaction context
    tx_hash FixedString(32),  -- 32 bytes, not hex string
    tx_index UInt16,  -- Max ~65k txs per block is already insane
    tx_success Bool,
    
    -- Block context
    block_number UInt32,  -- 4 billion blocks is centuries away
    block_hash FixedString(32),  -- 32 bytes
    block_time DateTime,
    block_date Date,
    
    -- Trace location
    trace_address Array(UInt16),  -- Path in trace tree, UInt16 plenty for trace depth
    
    -- Trace metadata
    type Enum8('call' = 0, 'create' = 1, 'suicide' = 2, 'reward' = 3),
    call_type Nullable(Enum8('call' = 0, 'delegatecall' = 1, 'staticcall' = 2, 'callcode' = 3)),
    success Bool,
    error Nullable(String),  -- Keep as string, error messages vary
    sub_traces UInt16,  -- Won't have 65k+ sub-traces
    
    -- Addresses (20 bytes each)
    from FixedString(20),
    to Nullable(FixedString(20)),
    address Nullable(FixedString(20)),  -- Created contract
    refund_address Nullable(FixedString(20)),  -- For selfdestruct
    
    -- Gas (30M block gas limit, UInt32 = 4B is plenty)
    gas UInt32,
    gas_used UInt32,
    net_gas UInt32,  -- gas_used - sum(children.gas_used)
    
    -- Value transfer
    value UInt256,  -- This actually needs to be big for wei
    
    -- Call data (binary, not hex strings)
    input String,  -- Variable length, can't use FixedString
    output Nullable(String),
    code Nullable(String)  -- Contract bytecode
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(block_date)
ORDER BY (block_number, tx_index, trace_address)
SETTINGS index_granularity = 8192;