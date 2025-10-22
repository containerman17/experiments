SELECT 
    CASE WHEN net_gas_used = 0 THEN 'zero' ELSE 'non-zero' END as net_gas_category,
    COUNT(*) as trace_count
FROM traces
GROUP BY net_gas_category