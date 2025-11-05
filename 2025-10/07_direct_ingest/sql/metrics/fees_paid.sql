-- Fees paid metric
-- Parameters: chain_id, first_period, last_period, granularity
-- Calculates sum of transaction fees (gas_used * gas_price) per period

CREATE TABLE IF NOT EXISTS fees_paid_{granularity} (
    chain_id UInt32,
    period DateTime,
    value UInt256,
    computed_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (chain_id, period);

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
