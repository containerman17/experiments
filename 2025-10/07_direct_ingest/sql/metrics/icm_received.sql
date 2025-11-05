-- ICM (Interchain Messaging) received metric
-- Parameters: chain_id, first_period, last_period, granularity
-- Counts ICM messages received by looking for specific topic0 in logs

CREATE TABLE IF NOT EXISTS icm_received_{granularity} (
    chain_id UInt32,
    period DateTime,
    value UInt64,
    computed_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (chain_id, period);

INSERT INTO icm_received_{granularity} (chain_id, period, value)
SELECT
    {chain_id:UInt32} as chain_id,
    toStartOf{granularity}(block_time) as period,
    count(*) as value
FROM raw_logs
WHERE chain_id = {chain_id:UInt32}
  AND block_time >= {first_period:DateTime}
  AND block_time < {last_period:DateTime}
  AND topic0 = unhex('292ee90bbaf70b5d4936025e09d56ba08f3e421156b6a568cf3c2840d9343e34')
GROUP BY period
ORDER BY period;
