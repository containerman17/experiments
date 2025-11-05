-- Active senders metric
-- Parameters: chain_id, first_period, last_period, granularity
-- Processes multiple periods in one query for efficient backfill
-- Counts unique addresses that sent transactions (from field only)

CREATE TABLE IF NOT EXISTS active_senders_{granularity} (
    chain_id UInt32,
    period DateTime,
    value UInt64,
    computed_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (chain_id, period);

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
