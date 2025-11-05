-- ================================================
-- CUMULATIVE CONTRACTS PER DAY
-- ================================================
-- Computes total cumulative contract creations up to each day
-- Only counts successful CREATE, CREATE2, and CREATE3 operations

-- Stats table with cumulative counts
CREATE TABLE IF NOT EXISTS cumulative_contracts_per_day (
    chain_id UInt32,
    day Date,
    cumulative_contract_count UInt64,
    computed_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (chain_id, day);

-- Refreshable MV that recalculates daily
-- Only processes COMPLETE days (excludes the latest blockchain day)
-- Recomputes cumulative for recently modified days
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_cumulative_contracts_per_day
REFRESH EVERY 1 DAY
TO cumulative_contracts_per_day
AS
WITH 
    latest_insert AS (
        -- Get the most recent insertion time
        SELECT max(inserted_at) as max_inserted_at
        FROM raw_traces
    ),
    max_block_day AS (
        -- Get the latest day that has data (blockchain time, not wall time)
        SELECT toDate(max(block_time)) as latest_day
        FROM raw_traces
        WHERE inserted_at >= (SELECT max_inserted_at FROM latest_insert) - INTERVAL 3 DAY
    ),
    earliest_affected_day AS (
        -- Find the earliest day that had recent insertions
        SELECT 
            chain_id,
            min(toDate(block_time)) as min_day
        FROM raw_traces
        WHERE inserted_at >= (SELECT max_inserted_at FROM latest_insert) - INTERVAL 3 DAY
        GROUP BY chain_id
    ),
    affected_days AS (
        -- Get all days from earliest affected to latest complete day
        -- This ensures cumulative counts are updated for all impacted days
        SELECT DISTINCT
            rt.chain_id,
            toDate(rt.block_time) as day
        FROM raw_traces rt
        INNER JOIN earliest_affected_day ead
            ON rt.chain_id = ead.chain_id
        WHERE toDate(rt.block_time) >= ead.min_day
          AND toDate(rt.block_time) < (SELECT latest_day FROM max_block_day)
    )
-- Calculate cumulative contract count for each affected day using JOIN
SELECT 
    ad.chain_id,
    ad.day,
    count(rt.tx_hash) as cumulative_contract_count,
    now() as computed_at
FROM affected_days ad
LEFT JOIN raw_traces rt ON 
    rt.chain_id = ad.chain_id
    AND toDate(rt.block_time) <= ad.day
    AND rt.call_type IN ('CREATE', 'CREATE2', 'CREATE3')
    AND rt.tx_success = true  -- Only successful contract creations
GROUP BY ad.chain_id, ad.day;

-- ================================================
-- USAGE
-- ================================================
-- Get cumulative contracts for specific day:
-- SELECT cumulative_contract_count 
-- FROM cumulative_contracts_per_day 
-- WHERE chain_id = 1 AND day = '2024-01-01';

-- Get growth trend:
-- SELECT 
--     day, 
--     cumulative_contract_count,
--     cumulative_contract_count - lag(cumulative_contract_count) OVER (ORDER BY day) as daily_new_contracts
-- FROM cumulative_contracts_per_day
-- WHERE chain_id = 1 AND day >= now() - INTERVAL 30 DAY
-- ORDER BY day;

-- Total contracts as of latest day:
-- SELECT max(cumulative_contract_count) as total_contracts
-- FROM cumulative_contracts_per_day
-- WHERE chain_id = 1;

-- ================================================
-- RECOVERY (if needed after crash)
-- ================================================
-- The MV will automatically recalculate on next refresh
-- To force immediate recalculation:
-- SYSTEM REFRESH VIEW mv_cumulative_contracts_per_day;

