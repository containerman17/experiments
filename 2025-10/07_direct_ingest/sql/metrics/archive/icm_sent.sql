-- ICM (Interchain Messaging) sent metric
-- Parameters: chain_id, first_period, last_period, granularity
-- Counts ICM messages sent by looking for specific topic0 in logs

CREATE TABLE IF NOT EXISTS icm_sent_{granularity} (
    chain_id UInt32,
    period DateTime,
    value UInt64,
    computed_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (chain_id, period);

INSERT INTO icm_sent_{granularity} (chain_id, period, value)
SELECT
    {chain_id:UInt32} as chain_id,
    toStartOf{granularity}(block_time) as period,
    count(*) as value
FROM raw_logs
WHERE chain_id = {chain_id:UInt32}
  AND block_time >= {first_period:DateTime}
  AND block_time < {last_period:DateTime}
  AND topic0 = unhex('2a211ad4a59ab9d003852404f9c57c690704ee755f3c79d2c2812ad32da99df8')
GROUP BY period
ORDER BY period;
