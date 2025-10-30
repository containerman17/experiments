-- Merge table for querying all active addresses
-- Combines data from both transaction and log MVs at query time
-- Executes AFTER the MVs (06 and 07) are created due to numeric prefix
CREATE TABLE IF NOT EXISTS metrics_activeAddresses AS mv_metrics_activeAddresses_transactions
ENGINE = Merge(currentDatabase(), '^mv_metrics_activeAddresses_.*');

-- This is a VIRTUAL table - no data storage, just query-time merging
-- When you query metrics_activeAddresses, it automatically queries all matching MVs

-- Query examples:
-- Hourly active addresses:
--   SELECT chain_id, hour_bucket, COUNT(DISTINCT address) as active_addresses 
--   FROM metrics_activeAddresses 
--   WHERE hour_bucket >= now() - INTERVAL 1 HOUR 
--   GROUP BY chain_id, hour_bucket
--
-- Daily active addresses:
--   SELECT chain_id, toStartOfDay(hour_bucket) as day, COUNT(DISTINCT address) as active_addresses
--   FROM metrics_activeAddresses  
--   WHERE hour_bucket >= now() - INTERVAL 24 HOUR
--   GROUP BY chain_id, day
