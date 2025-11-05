-- Maximum TPS metric  
-- Parameters: chain_id, first_period, last_period, granularity
-- Processes multiple periods in one query for efficient backfill

CREATE TABLE IF NOT EXISTS max_tps_{granularity} (
    chain_id UInt32,
    period DateTime,
    max_tps Float32,
    computed_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (chain_id, period);

INSERT INTO max_tps_{granularity} (chain_id, period, max_tps)
WITH tps_by_second AS (
    SELECT 
        toStartOf{granularity}(block_time) as period,
        toStartOfSecond(block_time) as second,
        count(*) as tx_per_second
    FROM raw_transactions
    WHERE chain_id = {chain_id:UInt32}
      AND block_time >= {first_period:DateTime}
      AND block_time < {last_period:DateTime}
    GROUP BY period, second
)
SELECT
    {chain_id:UInt32} as chain_id,
    period,
    max(tx_per_second) as max_tps
FROM tps_by_second
GROUP BY period
ORDER BY period;

