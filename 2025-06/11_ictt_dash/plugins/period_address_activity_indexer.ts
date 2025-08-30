import type { IndexingPlugin, TxBatch, BlocksDBHelper, betterSqlite3 } from "frostbyte-sdk";

interface PeriodAddressActivityData {
    periodAddressActivity: Array<{
        periodTs: number;
        address: string;
        txCount: number;
    }>;
}

const module: IndexingPlugin<PeriodAddressActivityData> = {
    name: "period_address_activity",
    version: 2,
    usesTraces: false,

    initialize: (db: betterSqlite3.Database) => {
        // Table to track unique addresses per day
        db.exec(`
            CREATE TABLE IF NOT EXISTS daily_address_activity (
                period_ts INTEGER NOT NULL,  -- Unix timestamp rounded down to 1 day period
                address TEXT NOT NULL,
                tx_count INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY (period_ts, address)
            )
        `);

        // Note: No additional indexes needed - the composite PRIMARY KEY (period_ts, address) 
        // is sufficient for both INSERT ON CONFLICT operations and queries
    },

    extractData: (batch: TxBatch): PeriodAddressActivityData => {
        // Accumulate data in memory
        const periodAddressMap = new Map<number, Map<string, number>>();
        const ONE_DAY = 86400; // 1 day in seconds

        for (const tx of batch.txs) {
            // Round down to 1 day period
            const periodTs = Math.floor(tx.blockTs / ONE_DAY) * ONE_DAY;

            // Get or create the address map for this period
            if (!periodAddressMap.has(periodTs)) {
                periodAddressMap.set(periodTs, new Map());
            }
            const addressMap = periodAddressMap.get(periodTs)!;

            // Track 'from' address
            const fromAddress = tx.tx.from;
            addressMap.set(fromAddress, (addressMap.get(fromAddress) || 0) + 1);

            // Track 'to' address if it exists
            if (tx.tx.to) {
                const toAddress = tx.tx.to;
                addressMap.set(toAddress, (addressMap.get(toAddress) || 0) + 1);
            }
        }

        // Convert nested maps to flat array for easier processing
        const periodAddressActivity: Array<{
            periodTs: number;
            address: string;
            txCount: number;
        }> = [];

        for (const [periodTs, addressMap] of periodAddressMap) {
            for (const [address, txCount] of addressMap) {
                periodAddressActivity.push({ periodTs, address, txCount });
            }
        }

        return { periodAddressActivity };
    },

    saveExtractedData: (
        db: betterSqlite3.Database,
        blocksDb: BlocksDBHelper,
        data: PeriodAddressActivityData
    ) => {
        if (data.periodAddressActivity.length === 0) return;

        // Prepare statement for batch operations
        const insertAddressStmt = db.prepare(`
            INSERT INTO daily_address_activity (period_ts, address, tx_count)
            VALUES (?, ?, ?)
            ON CONFLICT(period_ts, address) DO UPDATE SET
                tx_count = tx_count + excluded.tx_count
        `);

        // Insert all address activity
        for (const activity of data.periodAddressActivity) {
            insertAddressStmt.run(activity.periodTs, activity.address, activity.txCount);
        }
    }
};

export default module;
