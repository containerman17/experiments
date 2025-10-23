SELECT 
    to as contract,
    COUNT(DISTINCT `from`) as unique_callers,
    COUNT(*) as tx_count
FROM transactions
WHERE to IS NOT NULL
GROUP BY to
ORDER BY unique_callers DESC
LIMIT 20