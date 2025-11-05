-- Gas used metric
-- Parameters: chain_id, first_period, last_period, granularity
-- Processes multiple periods in one query for efficient backfill
-- Sums gas used by all transactions in the time interval

CREATE TABLE IF NOT EXISTS gas_used_{granularity} (
    chain_id UInt32,
    period DateTime,
    value UInt64,
    computed_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (chain_id, period);

INSERT INTO gas_used_{granularity} (chain_id, period, value)
SELECT
    {chain_id:UInt32} as chain_id,
    toStartOf{granularity}(block_time) as period,
    sum(gas_used) as value
FROM raw_transactions
WHERE chain_id = {chain_id:UInt32}
  AND block_time >= {first_period:DateTime}
  AND block_time < {last_period:DateTime}
GROUP BY period
ORDER BY period;
