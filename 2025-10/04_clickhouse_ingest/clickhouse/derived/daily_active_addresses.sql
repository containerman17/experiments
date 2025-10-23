-- Daily active addresses aggregation table
CREATE TABLE IF NOT EXISTS daily_active_addresses_agg
(
    block_date Date,
    addresses AggregateFunction(uniq, Nullable(FixedString(42)))
)
ENGINE = AggregatingMergeTree
ORDER BY block_date;

-- Materialized view for transactions addresses
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_transactions_addresses
TO daily_active_addresses_agg
AS
SELECT 
    block_date,
    uniqState(CAST(address AS Nullable(FixedString(42)))) as addresses
FROM (
    SELECT block_date, `from` as address FROM transactions
    UNION ALL
    SELECT block_date, `to` as address FROM transactions WHERE `to` IS NOT NULL
)
GROUP BY block_date;

-- Materialized view for traces addresses
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_traces_addresses
TO daily_active_addresses_agg
AS
SELECT 
    block_date,
    uniqState(CAST(address AS Nullable(FixedString(42)))) as addresses
FROM (
    SELECT block_date, `from` as address FROM traces
    UNION ALL
    SELECT block_date, `to` as address FROM traces WHERE `to` IS NOT NULL
)
GROUP BY block_date;

-- Materialized view for logs addresses
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_logs_addresses
TO daily_active_addresses_agg
AS
SELECT 
    block_date,
    uniqState(CAST(address AS Nullable(FixedString(42)))) as addresses
FROM (
    SELECT block_date, tx_from as address FROM logs
    UNION ALL
    SELECT block_date, tx_to as address FROM logs
)
GROUP BY block_date;

-- Query to get daily active addresses:
-- SELECT block_date, uniqMerge(addresses) as active_addresses
-- FROM daily_active_addresses_agg
-- GROUP BY block_date
-- ORDER BY block_date;

