-- Active addresses metrics (regular and cumulative)
-- Parameters: chain_id, first_period, last_period, granularity

-- Regular active addresses table
CREATE TABLE IF NOT EXISTS active_addresses_{granularity} (
    chain_id UInt32,
    period DateTime64(3, 'UTC'),  -- Period start time
    value UInt64,
    computed_at DateTime64(3, 'UTC') DEFAULT now64(3)
) ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (chain_id, period);

-- Insert regular active address counts
-- Counts unique addresses (both from and to) per period
INSERT INTO active_addresses_{granularity} (chain_id, period, value)
SELECT
    {chain_id:UInt32} as chain_id,
    toStartOf{granularity}(block_time) as period,
    uniq(address) as value
FROM (
    SELECT from as address, block_time
    FROM raw_traces
    WHERE chain_id = {chain_id:UInt32}
      AND block_time >= {first_period:DateTime}
      AND block_time < {last_period:DateTime}
      AND from != unhex('0000000000000000000000000000000000000000')
    
    UNION ALL
    
    SELECT to as address, block_time
    FROM raw_traces
    WHERE chain_id = {chain_id:UInt32}
      AND block_time >= {first_period:DateTime}
      AND block_time < {last_period:DateTime}
      AND to IS NOT NULL
      AND to != unhex('0000000000000000000000000000000000000000')
)
GROUP BY period
ORDER BY period;

-- Cumulative addresses table
CREATE TABLE IF NOT EXISTS cumulative_addresses_{granularity} (
    chain_id UInt32,
    period DateTime64(3, 'UTC'),  -- Period start time
    value UInt64,
    computed_at DateTime64(3, 'UTC') DEFAULT now64(3)
) ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (chain_id, period);

-- Insert cumulative address counts
-- Tracks total unique addresses that have ever appeared
INSERT INTO cumulative_addresses_{granularity} (chain_id, period, value)
WITH 
-- Get the last cumulative value before our range
previous_cumulative AS (
    SELECT max(value) as prev_value
    FROM cumulative_addresses_{granularity} FINAL
    WHERE chain_id = {chain_id:UInt32}
      AND period < {first_period:DateTime}
),
-- Get all addresses seen before our period range
addresses_before AS (
    SELECT DISTINCT address
    FROM (
        SELECT from as address
        FROM raw_traces
        WHERE chain_id = {chain_id:UInt32}
          AND block_time < {first_period:DateTime}
          AND from != unhex('0000000000000000000000000000000000000000')
        
        UNION ALL
        
        SELECT to as address
        FROM raw_traces
        WHERE chain_id = {chain_id:UInt32}
          AND block_time < {first_period:DateTime}
          AND to IS NOT NULL
          AND to != unhex('0000000000000000000000000000000000000000')
    )
),
-- Get NEW addresses that first appear in our period range
new_addresses AS (
    SELECT address, min(first_seen_period) as first_period
    FROM (
        SELECT from as address, min(toStartOf{granularity}(block_time)) as first_seen_period
        FROM raw_traces
        WHERE chain_id = {chain_id:UInt32}
          AND block_time >= {first_period:DateTime}
          AND block_time < {last_period:DateTime}
          AND from != unhex('0000000000000000000000000000000000000000')
          AND from NOT IN (SELECT address FROM addresses_before)
        GROUP BY address
        
        UNION ALL
        
        SELECT to as address, min(toStartOf{granularity}(block_time)) as first_seen_period
        FROM raw_traces
        WHERE chain_id = {chain_id:UInt32}
          AND block_time >= {first_period:DateTime}
          AND block_time < {last_period:DateTime}
          AND to IS NOT NULL
          AND to != unhex('0000000000000000000000000000000000000000')
          AND to NOT IN (SELECT address FROM addresses_before)
        GROUP BY address
    )
    GROUP BY address
),
period_new AS (
    -- Count new addresses per period
    SELECT 
        first_period as period,
        count(*) as new_addresses
    FROM new_addresses
    GROUP BY period
)
SELECT
    {chain_id:UInt32} as chain_id,
    period,
    -- Add previous cumulative value to our running sum
    ifNull((SELECT prev_value FROM previous_cumulative), 0) + 
    sum(new_addresses) OVER (ORDER BY period) as value
FROM period_new
ORDER BY period;

