import type { IndexingPlugin } from "frostbyte-sdk";

const module: IndexingPlugin = {
    name: "minute_tx_counter",
    version: 11,
    usesTraces: false,

    initialize: (db) => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS minute_tx_counts (
                minute_ts INTEGER PRIMARY KEY,  -- Unix timestamp rounded down to minute
                tx_count INTEGER NOT NULL,
                gas_used INTEGER NOT NULL DEFAULT 0
            )
        `);

        db.exec(`
            CREATE TABLE IF NOT EXISTS cumulative_tx_counts (
                minute_ts INTEGER PRIMARY KEY,  -- Unix timestamp rounded down to minute
                cumulative_count INTEGER NOT NULL,
                cumulative_gas_used INTEGER NOT NULL DEFAULT 0
            )
        `);

        try {
            db.exec(`
                CREATE INDEX IF NOT EXISTS idx_minute_ts ON minute_tx_counts(minute_ts)
            `);
        } catch (error: any) {
            // Ignore error if index already exists
            if (!error.message.includes('already exists')) {
                throw error;
            }
        }

        try {
            db.exec(`
                CREATE INDEX IF NOT EXISTS idx_cumulative_minute_ts ON cumulative_tx_counts(minute_ts)
            `);
        } catch (error: any) {
            // Ignore error if index already exists
            if (!error.message.includes('already exists')) {
                throw error;
            }
        }
    },

    handleTxBatch: (db, blocksDb, batch) => {
        // Accumulate tx counts and gas usage by minute in memory
        const minuteStats = new Map<number, { count: number, gasUsed: number }>();

        for (const tx of batch.txs) {
            const ts = tx.blockTs;
            const minuteTs = Math.floor(ts / 60) * 60;
            const stats = minuteStats.get(minuteTs) || { count: 0, gasUsed: 0 };
            stats.count += 1;
            stats.gasUsed += Number(tx.receipt.gasUsed || 0);
            minuteStats.set(minuteTs, stats);
        }

        // Only write to DB if we have accumulated enough data
        if (minuteStats.size === 0) return;

        // Sort minutes to process them in chronological order
        const sortedMinutes = Array.from(minuteStats.entries()).sort((a, b) => a[0] - b[0]);

        // Prepare statements for batch operations
        const insertMinuteStmt = db.prepare(`
            INSERT INTO minute_tx_counts (minute_ts, tx_count, gas_used)
            VALUES (?, ?, ?)
            ON CONFLICT(minute_ts) DO UPDATE SET
                tx_count = tx_count + excluded.tx_count,
                gas_used = gas_used + excluded.gas_used
        `);

        // Process each minute - just update counts, not cumulative
        for (const [minuteTs, stats] of sortedMinutes) {
            insertMinuteStmt.run(minuteTs, stats.count, stats.gasUsed);
        }

        // After all minutes are updated, recalculate cumulative counts for affected range
        const minTs = sortedMinutes[0]![0];
        const maxTs = sortedMinutes[sortedMinutes.length - 1]![0];

        // Get cumulative totals before our range
        const beforeStmt = db.prepare(`
            SELECT 
                COALESCE(SUM(tx_count), 0) as total_count,
                COALESCE(SUM(gas_used), 0) as total_gas
            FROM minute_tx_counts 
            WHERE minute_ts < ?
        `);
        const beforeTotals = beforeStmt.get(minTs) as { total_count: number, total_gas: number };

        // Get all minutes from minTs onwards to recalculate
        const getMinutesStmt = db.prepare(`
            SELECT minute_ts, tx_count, gas_used
            FROM minute_tx_counts
            WHERE minute_ts >= ?
            ORDER BY minute_ts ASC
        `);
        const allMinutes = getMinutesStmt.all(minTs) as Array<{ minute_ts: number, tx_count: number, gas_used: number }>;

        // Recalculate cumulative counts
        let runningTotal = beforeTotals.total_count;
        let runningGasTotal = beforeTotals.total_gas;

        const upsertCumulativeStmt = db.prepare(`
            INSERT INTO cumulative_tx_counts (minute_ts, cumulative_count, cumulative_gas_used)
            VALUES (?, ?, ?)
            ON CONFLICT(minute_ts) DO UPDATE SET
                cumulative_count = excluded.cumulative_count,
                cumulative_gas_used = excluded.cumulative_gas_used
        `);

        for (const minute of allMinutes) {
            runningTotal += minute.tx_count;
            runningGasTotal += minute.gas_used;
            upsertCumulativeStmt.run(minute.minute_ts, runningTotal, runningGasTotal);
        }
    }
};

export default module; 
