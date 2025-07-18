import type { IndexingPlugin } from "frostbyte-sdk";

const module: IndexingPlugin = {
    name: "minute_tx_counter",
    version: 5,
    usesTraces: false,

    initialize: async (db) => {
        await db.execute(`
            CREATE TABLE minute_tx_counts (
                minute_ts INT PRIMARY KEY,  -- Unix timestamp rounded down to minute
                tx_count INT NOT NULL
            )
        `);

        await db.execute(`
            CREATE INDEX idx_minute_ts ON minute_tx_counts(minute_ts)
        `);

        await db.execute(`
            CREATE TABLE cumulative_tx_counts (
                minute_ts INT PRIMARY KEY,  -- Unix timestamp rounded down to minute
                cumulative_count INT NOT NULL
            )
        `);

        await db.execute(`
            CREATE INDEX idx_cumulative_minute_ts ON cumulative_tx_counts(minute_ts)
        `);
    },

    handleTxBatch: async (db, blocksDb, batch) => {
        // Accumulate tx counts by minute in memory
        const minuteCounts = new Map<number, number>();

        for (const tx of batch.txs) {
            const ts = tx.blockTs;
            const minuteTs = Math.floor(ts / 60) * 60;
            minuteCounts.set(minuteTs, (minuteCounts.get(minuteTs) || 0) + 1);
        }

        // Only write to DB if we have accumulated enough data
        if (minuteCounts.size === 0) return;

        // Sort minutes to process them in chronological order
        const sortedMinutes = Array.from(minuteCounts.entries()).sort((a, b) => a[0] - b[0]);
        const firstMinuteTs = sortedMinutes[0]![0];

        // Get the cumulative count just before our first minute
        const [rows] = await db.execute(
            'SELECT cumulative_count FROM cumulative_tx_counts WHERE minute_ts < ? ORDER BY minute_ts DESC LIMIT 1',
            [firstMinuteTs]
        );
        const previousCumulative = (rows as { cumulative_count: number }[])[0];

        let runningTotal = previousCumulative?.cumulative_count || 0;

        // Process in chunks to avoid MySQL placeholder limit
        const CHUNK_SIZE = 1000; // Safe chunk size for batch inserts

        for (let i = 0; i < sortedMinutes.length; i += CHUNK_SIZE) {
            const chunk = sortedMinutes.slice(i, i + CHUNK_SIZE);

            // Batch insert minute counts for this chunk
            const minuteValues = chunk.map(([minuteTs, count]) => [minuteTs, count]);
            const minutePlaceholders = minuteValues.map(() => '(?, ?)').join(', ');
            const minuteParams = minuteValues.flat();

            await db.execute(`
                INSERT INTO minute_tx_counts (minute_ts, tx_count)
                VALUES ${minutePlaceholders}
                ON DUPLICATE KEY UPDATE
                    tx_count = tx_count + VALUES(tx_count)
            `, minuteParams);

            // Batch insert cumulative counts for this chunk
            const cumulativeValues = chunk.map(([minuteTs, count]) => {
                runningTotal += count;
                return [minuteTs, runningTotal];
            });
            const cumulativePlaceholders = cumulativeValues.map(() => '(?, ?)').join(', ');
            const cumulativeParams = cumulativeValues.flat();

            await db.execute(`
                INSERT INTO cumulative_tx_counts (minute_ts, cumulative_count)
                VALUES ${cumulativePlaceholders}
                ON DUPLICATE KEY UPDATE
                    cumulative_count = VALUES(cumulative_count)
            `, cumulativeParams);
        }
    }
};

export default module; 
