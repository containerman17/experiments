-- Fees paid metrics (regular and cumulative)
-- Parameters: chain_id, first_period, last_period, granularity

-- Regular fees paid table
CREATE TABLE IF NOT EXISTS fees_paid_{granularity} (
    chain_id UInt32,
    period DateTime64(3, 'UTC'),  -- Period start time
    value UInt256,
    computed_at DateTime64(3, 'UTC') DEFAULT now64(3)
) ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (chain_id, period);

-- Insert regular fees paid values
-- Calculates sum of transaction fees (gas_used * gas_price) per period
INSERT INTO fees_paid_{granularity} (chain_id, period, value)
SELECT
    {chain_id:UInt32} as chain_id,
    toStartOf{granularity}(block_time) as period,
    sum(toUInt256(gas_used) * toUInt256(gas_price)) as value
FROM raw_transactions
WHERE chain_id = {chain_id:UInt32}
  AND block_time >= {first_period:DateTime}
  AND block_time < {last_period:DateTime}
GROUP BY period
ORDER BY period;

-- Cumulative fees paid table
CREATE TABLE IF NOT EXISTS cumulative_fees_paid_{granularity} (
    chain_id UInt32,
    period DateTime64(3, 'UTC'),  -- Period start time
    value UInt256,
    computed_at DateTime64(3, 'UTC') DEFAULT now64(3)
) ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (chain_id, period);

-- Insert cumulative fees paid (uses the regular values we just calculated)
INSERT INTO cumulative_fees_paid_{granularity} (chain_id, period, value)
WITH 
-- Get the last cumulative value before our range
previous_cumulative AS (
    SELECT max(value) as prev_value
    FROM cumulative_fees_paid_{granularity} FINAL
    WHERE chain_id = {chain_id:UInt32}
      AND period < {first_period:DateTime}
),
-- Get fee values from regular table for our period range (use FINAL to get deduplicated values)
period_values AS (
    SELECT 
        period,
        value as period_value
    FROM fees_paid_{granularity} FINAL
    WHERE chain_id = {chain_id:UInt32}
      AND period >= {first_period:DateTime}
      AND period < {last_period:DateTime}
)
SELECT
    {chain_id:UInt32} as chain_id,
    period,
    -- Add previous cumulative value to our running sum
    ifNull((SELECT prev_value FROM previous_cumulative), 0) + 
    sum(period_value) OVER (ORDER BY period) as value
FROM period_values
ORDER BY period;

