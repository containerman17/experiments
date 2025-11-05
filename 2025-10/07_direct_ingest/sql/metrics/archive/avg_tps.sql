-- Average Transactions Per Second metric
-- Parameters: chain_id, first_period, last_period, granularity, period_seconds
-- Calculates average TPS - total transactions divided by seconds in the period

CREATE TABLE IF NOT EXISTS avg_tps_{granularity} (
    chain_id UInt32,
    period DateTime,
    value UInt64,
    computed_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (chain_id, period);

INSERT INTO avg_tps_{granularity} (chain_id, period, value)
SELECT
    {chain_id:UInt32} as chain_id,
    toStartOf{granularity}(block_time) as period,
    CAST(count(*) / {period_seconds:UInt64} AS UInt64) as value
FROM raw_transactions
WHERE chain_id = {chain_id:UInt32}
  AND block_time >= {first_period:DateTime}
  AND block_time < {last_period:DateTime}
GROUP BY period
ORDER BY period;
