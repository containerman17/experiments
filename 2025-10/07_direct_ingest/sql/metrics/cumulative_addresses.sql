-- Cumulative addresses metric
-- Parameters: chain_id, first_period, last_period, granularity
-- Calculates cumulative unique addresses (from and to) for multiple periods in one query

CREATE TABLE IF NOT EXISTS cumulative_addresses_{granularity} (
    chain_id UInt32,
    period DateTime,
    value UInt64,
    computed_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (chain_id, period);

INSERT INTO cumulative_addresses_{granularity} (chain_id, period, value)
WITH all_addresses AS (
    -- Get all unique addresses up to last_period
    SELECT DISTINCT address, min(first_seen_period) as first_period
    FROM (
        SELECT from as address, min(toStartOf{granularity}(block_time)) as first_seen_period
        FROM raw_traces
        WHERE chain_id = {chain_id:UInt32}
          AND block_time < {last_period:DateTime}
          AND from != unhex('0000000000000000000000000000000000000000')
        GROUP BY address
        
        UNION ALL
        
        SELECT to as address, min(toStartOf{granularity}(block_time)) as first_seen_period
        FROM raw_traces
        WHERE chain_id = {chain_id:UInt32}
          AND block_time < {last_period:DateTime}
          AND to IS NOT NULL
          AND to != unhex('0000000000000000000000000000000000000000')
        GROUP BY address
    )
    GROUP BY address
),
period_new AS (
    -- Count new addresses per period
    SELECT 
        first_period as period,
        count(*) as new_addresses
    FROM all_addresses
    GROUP BY period
)
SELECT
    {chain_id:UInt32} as chain_id,
    period,
    sum(new_addresses) OVER (ORDER BY period) as value
FROM period_new
WHERE period >= {first_period:DateTime}
  AND period < {last_period:DateTime}
ORDER BY period;
