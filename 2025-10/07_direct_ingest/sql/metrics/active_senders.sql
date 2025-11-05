-- Active senders metrics (regular and cumulative)
-- Parameters: chain_id, first_period, last_period, granularity

-- Regular active senders table
CREATE TABLE IF NOT EXISTS active_senders_{granularity} (
    chain_id UInt32,
    period DateTime64(3, 'UTC'),  -- Period start time
    value UInt64,
    computed_at DateTime64(3, 'UTC') DEFAULT now64(3)
) ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (chain_id, period);

-- Insert regular active sender counts
-- Counts unique addresses that sent transactions (from field only)
INSERT INTO active_senders_{granularity} (chain_id, period, value)
SELECT
    {chain_id:UInt32} as chain_id,
    toStartOf{granularity}(block_time) as period,
    uniq(from) as value
FROM raw_traces
WHERE chain_id = {chain_id:UInt32}
  AND block_time >= {first_period:DateTime}
  AND block_time < {last_period:DateTime}
  AND from != unhex('0000000000000000000000000000000000000000')
GROUP BY period
ORDER BY period;

-- Cumulative active senders table
CREATE TABLE IF NOT EXISTS cumulative_active_senders_{granularity} (
    chain_id UInt32,
    period DateTime64(3, 'UTC'),  -- Period start time
    value UInt64,
    computed_at DateTime64(3, 'UTC') DEFAULT now64(3)
) ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (chain_id, period);

-- Insert cumulative active sender counts
-- Tracks total unique senders that have ever sent transactions
INSERT INTO cumulative_active_senders_{granularity} (chain_id, period, value)
WITH 
-- Get the last cumulative value before our range
previous_cumulative AS (
    SELECT max(value) as prev_value
    FROM cumulative_active_senders_{granularity} FINAL
    WHERE chain_id = {chain_id:UInt32}
      AND period < {first_period:DateTime}
),
-- Get senders who sent transactions before our period range
senders_before AS (
    SELECT DISTINCT from as sender
    FROM raw_traces
    WHERE chain_id = {chain_id:UInt32}
      AND block_time < {first_period:DateTime}
      AND from != unhex('0000000000000000000000000000000000000000')
),
-- Get NEW senders that first send in our period range
new_sender_first_seen AS (
    SELECT 
        from as sender,
        min(toStartOf{granularity}(block_time)) as first_send_period
    FROM raw_traces
    WHERE chain_id = {chain_id:UInt32}
      AND block_time >= {first_period:DateTime}
      AND block_time < {last_period:DateTime}
      AND from != unhex('0000000000000000000000000000000000000000')
      AND from NOT IN (SELECT sender FROM senders_before)
    GROUP BY sender
),
period_new AS (
    -- Count new senders per period
    SELECT 
        first_send_period as period,
        count(*) as new_senders
    FROM new_sender_first_seen
    GROUP BY period
)
SELECT
    {chain_id:UInt32} as chain_id,
    period,
    -- Add previous cumulative value to our running sum
    ifNull((SELECT prev_value FROM previous_cumulative), 0) + 
    sum(new_senders) OVER (ORDER BY period) as value
FROM period_new
ORDER BY period;

