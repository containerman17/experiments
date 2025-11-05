-- Contracts created metric
-- Parameters: chain_id, first_period, last_period, granularity
-- Processes multiple periods in one query for efficient backfill
-- Counts contracts created via CREATE, CREATE2, CREATE3 call types

CREATE TABLE IF NOT EXISTS contracts_{granularity} (
    chain_id UInt32,
    period DateTime,
    value UInt64,
    computed_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (chain_id, period);

INSERT INTO contracts_{granularity} (chain_id, period, value)
SELECT
    {chain_id:UInt32} as chain_id,
    toStartOf{granularity}(block_time) as period,
    count(*) as value
FROM raw_traces
WHERE chain_id = {chain_id:UInt32}
  AND block_time >= {first_period:DateTime}
  AND block_time < {last_period:DateTime}
  AND call_type IN ('CREATE', 'CREATE2', 'CREATE3')
  AND tx_success = true
GROUP BY period
ORDER BY period;
