-- ================================================
-- MAX TPS PER HOUR - RECOVERY SCRIPT
-- ================================================
-- Simple recovery: just trigger the MV to recalculate immediately
-- The MV will automatically process all recent data based on max(inserted_at)

-- Force immediate refresh of the materialized view
SYSTEM REFRESH VIEW mv_max_tps_per_hour;
