-- Watermark table for tracking metric processing progress
CREATE TABLE IF NOT EXISTS metric_watermarks (
    chain_id UInt32,
    metric_name String,  -- e.g., "tx_count_hour", "tx_count_day"
    last_period DateTime64(3, 'UTC'),  -- Last processed period
    updated_at DateTime64(3, 'UTC') DEFAULT now64(3)
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (chain_id, metric_name);
