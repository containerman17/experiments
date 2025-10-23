SELECT 
    to as contract,
    SUM(net_gas_used) as total_net_gas_used,
    COUNT(*) as trace_count
FROM traces
WHERE to IS NOT NULL
GROUP BY to
ORDER BY total_net_gas_used DESC
LIMIT 20