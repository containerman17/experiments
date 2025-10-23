SELECT 
    MAX(tps) as max_tps, 
    argMax(block_time, tps) as when_occurred 
FROM (
    SELECT block_time, COUNT(*) as tps 
    FROM transactions 
    WHERE block_time >= (SELECT MAX(block_time) - INTERVAL 7 DAY FROM transactions) 
    GROUP BY block_time
)