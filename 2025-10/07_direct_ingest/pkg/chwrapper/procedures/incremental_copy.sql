-- Incremental copy with staging checkpoint for consistency
-- Run these statements in order

-- STEP 1: Set staging boundary (snapshot the target)
INSERT INTO checkpoints (table_name, last_inserted_at)
SELECT 
    'transactions_by_hash_staging' as table_name,
    max(inserted_at) as last_inserted_at
FROM raw_transactions;

-- STEP 2: Copy everything between current and staging checkpoint
INSERT INTO transactions_by_hash
SELECT 
    chain_id, hash, block_number, block_hash, block_time,
    transaction_index, nonce, from, to, value,
    gas_limit, gas_price, gas_used, success, input,
    type, max_fee_per_gas, max_priority_fee_per_gas,
    priority_fee_per_gas, base_fee_per_gas,
    contract_address, access_list
FROM raw_transactions
WHERE inserted_at > COALESCE(
        (SELECT last_inserted_at FROM checkpoints WHERE table_name = 'transactions_by_hash'),
        toDateTime64('2000-01-01 00:00:00', 3)
    )
  AND inserted_at <= (SELECT last_inserted_at FROM checkpoints WHERE table_name = 'transactions_by_hash_staging')
ORDER BY inserted_at;
-- No LIMIT - we process everything up to staging checkpoint

-- STEP 3: Flip staging to current (atomic checkpoint update)
INSERT INTO checkpoints (table_name, last_inserted_at)
SELECT 
    'transactions_by_hash' as table_name,
    last_inserted_at
FROM checkpoints 
WHERE table_name = 'transactions_by_hash_staging';