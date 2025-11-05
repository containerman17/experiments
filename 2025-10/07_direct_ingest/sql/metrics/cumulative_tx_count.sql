-- Cumulative transaction count metric
-- Parameters: chain_id, first_period, last_period, granularity
-- Calculates cumulative counts for multiple periods in one query

CREATE TABLE IF NOT EXISTS cumulative_tx_count_{granularity} (
    chain_id UInt32,
    period DateTime,
    value UInt64,
    computed_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (chain_id, period);

INSERT INTO cumulative_tx_count_{granularity} (chain_id, period, value)
WITH period_counts AS (
    SELECT 
        toStartOf{granularity}(block_time) as period,
        count(*) as period_count
    FROM raw_transactions
    WHERE chain_id = {chain_id:UInt32}
      AND block_time < {last_period:DateTime}
    GROUP BY period
)
SELECT
    {chain_id:UInt32} as chain_id,
    period,
    sum(period_count) OVER (ORDER BY period) as value
FROM period_counts
WHERE period >= {first_period:DateTime}
  AND period < {last_period:DateTime}
ORDER BY period;

