SELECT 
    date,
    SUM(gas_used) as total_gas_used
FROM blocks
GROUP BY date
ORDER BY date DESC