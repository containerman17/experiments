-- Merge table for querying all active senders
-- Combines data from both transaction and log MVs at query time
-- Named with 'zz_' prefix to ensure it executes AFTER the MVs are created
CREATE TABLE IF NOT EXISTS metrics_activeSenders AS mv_metrics_activeSenders_transactions
ENGINE = Merge(currentDatabase(), '^mv_metrics_activeSenders_.*');

-- This is a VIRTUAL table - no data storage, just query-time merging
-- When you query metrics_activeSenders, it automatically queries all matching MVs

-- Query examples:
-- Hourly active senders:
--   SELECT chain_id, hour_bucket, COUNT(DISTINCT address) as active_senders 
--   FROM metrics_activeSenders 
--   WHERE hour_bucket >= now() - INTERVAL 1 HOUR 
--   GROUP BY chain_id, hour_bucket
--
-- Daily active senders:
--   SELECT chain_id, toStartOfDay(hour_bucket) as day, COUNT(DISTINCT address) as active_senders
--   FROM metrics_activeSenders  
--   WHERE hour_bucket >= now() - INTERVAL 24 HOUR
--   GROUP BY chain_id, day

