-- Cumulative transaction count metric
-- Parameters: chain_id, first_period, last_period
-- Calculates cumulative counts for multiple days in one query

CREATE TABLE IF NOT EXISTS cumulative_tx_count (
    chain_id UInt32,
    period Date,
    cumulative_tx_count UInt64,
    computed_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (chain_id, period);

INSERT INTO cumulative_tx_count (chain_id, period, cumulative_tx_count)
WITH daily_counts AS (
    SELECT 
        toDate(block_time) as day,
        count(*) as day_count
    FROM raw_transactions
    WHERE chain_id = {chain_id:UInt32}
      AND toDate(block_time) <= {last_period:Date}
    GROUP BY day
)
SELECT
    {chain_id:UInt32} as chain_id,
    day as period,
    sum(day_count) OVER (ORDER BY day) as cumulative_tx_count
FROM daily_counts
WHERE day >= {first_period:Date}
  AND day <= {last_period:Date}
ORDER BY day;

