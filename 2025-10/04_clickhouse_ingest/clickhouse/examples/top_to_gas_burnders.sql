SELECT 
    to,
    SUM(gas_used) as total_gas_used,
    COUNT(*) as tx_count
FROM transactions
WHERE to IS NOT NULL
GROUP BY to
ORDER BY total_gas_used DESC
LIMIT 20