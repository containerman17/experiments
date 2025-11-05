-- Cumulative deployers metric
-- Parameters: chain_id, first_period, last_period, granularity
-- Calculates cumulative count of unique contract deployers for multiple periods in one query

CREATE TABLE IF NOT EXISTS cumulative_deployers_{granularity} (
    chain_id UInt32,
    period DateTime,
    value UInt64,
    computed_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (chain_id, period);

INSERT INTO cumulative_deployers_{granularity} (chain_id, period, value)
WITH deployer_first_seen AS (
    -- Get first deployment period for each unique deployer
    SELECT 
        from as deployer,
        min(toStartOf{granularity}(block_time)) as first_deploy_period
    FROM raw_traces
    WHERE chain_id = {chain_id:UInt32}
      AND block_time < {last_period:DateTime}
      AND call_type IN ('CREATE', 'CREATE2', 'CREATE3')
      AND tx_success = true
      AND from != unhex('0000000000000000000000000000000000000000')
    GROUP BY deployer
),
period_new AS (
    -- Count new deployers per period
    SELECT 
        first_deploy_period as period,
        count(*) as new_deployers
    FROM deployer_first_seen
    GROUP BY period
)
SELECT
    {chain_id:UInt32} as chain_id,
    period,
    sum(new_deployers) OVER (ORDER BY period) as value
FROM period_new
WHERE period >= {first_period:DateTime}
  AND period < {last_period:DateTime}
ORDER BY period;
