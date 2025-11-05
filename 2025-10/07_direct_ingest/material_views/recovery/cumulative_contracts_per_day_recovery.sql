-- ================================================
-- CUMULATIVE CONTRACTS PER DAY - RECOVERY SCRIPT
-- ================================================
-- Simple recovery: just trigger the MV to recalculate immediately
-- The MV will automatically process all recent data based on max(inserted_at)

-- Force immediate refresh of the materialized view
SYSTEM REFRESH VIEW mv_cumulative_contracts_per_day;

