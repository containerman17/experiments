import type { IndexingPlugin, TxBatch, BlocksDBHelper, betterSqlite3 } from "frostbyte-sdk";

interface InteractionRecord {
    from: string;
    to: string;
    timestamp: number;
    txCount: number;
}

interface DailyInteractionsData {
    interactions: InteractionRecord[];
}

const SECONDS_PER_DAY = 86400;

const module: IndexingPlugin<DailyInteractionsData> = {
    name: "daily_interactions",
    version: 14,
    usesTraces: false,

    initialize: (db: betterSqlite3.Database) => {
        // Create table for daily interactions between addresses
        db.exec(`
            CREATE TABLE IF NOT EXISTS daily_interactions (
                from_address TEXT NOT NULL,
                to_address TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                tx_count INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (from_address, to_address, timestamp)
            )
        `);

        // Create indexes for efficient queries
        db.exec(`
            CREATE INDEX IF NOT EXISTS idx_daily_interactions_from 
            ON daily_interactions (from_address, timestamp)
        `);

        db.exec(`
            CREATE INDEX IF NOT EXISTS idx_daily_interactions_to 
            ON daily_interactions (to_address, timestamp)
        `);
    },

    extractData: (batch: TxBatch): DailyInteractionsData => {
        // Use Map for efficient deduplication, then convert to array
        const interactionMap = new Map<string, InteractionRecord>();

        for (const { tx, blockTs } of batch.txs) {
            // Skip transactions without a recipient (contract creation)
            if (!tx.to) continue;

            // Round timestamp to day
            const dayTimestamp = Math.floor(blockTs / SECONDS_PER_DAY) * SECONDS_PER_DAY;

            // Use minimal string key for deduplication
            const key = tx.from + tx.to + dayTimestamp;

            const existing = interactionMap.get(key);
            if (existing) {
                existing.txCount += 1;
            } else {
                interactionMap.set(key, {
                    from: tx.from,
                    to: tx.to,
                    timestamp: dayTimestamp,
                    txCount: 1
                });
            }
        }

        // Convert to array for simpler iteration in save
        return {
            interactions: Array.from(interactionMap.values())
        };
    },

    saveExtractedData: (
        db: betterSqlite3.Database,
        blocksDb: BlocksDBHelper,
        data: DailyInteractionsData
    ) => {
        const { interactions } = data;

        // Skip if no data to save
        if (interactions.length === 0) return;

        // Deduplicate interactions in memory first
        const dedupedMap = new Map<string, InteractionRecord>();
        for (const interaction of interactions) {
            const key = `${interaction.from}|${interaction.to}|${interaction.timestamp}`;
            const existing = dedupedMap.get(key);
            if (existing) {
                existing.txCount += interaction.txCount;
            } else {
                dedupedMap.set(key, { ...interaction });
            }
        }

        // Use simple INSERT OR REPLACE - SQLite will handle the merge
        const upsertStmt = db.prepare(`
            INSERT INTO daily_interactions (from_address, to_address, timestamp, tx_count)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(from_address, to_address, timestamp) 
            DO UPDATE SET tx_count = tx_count + excluded.tx_count
        `);

        for (const interaction of dedupedMap.values()) {
            upsertStmt.run(
                interaction.from,
                interaction.to,
                interaction.timestamp,
                interaction.txCount
            );
        }

        console.log(`Daily Interactions: Updated ${dedupedMap.size} interaction entries`);
    }
};

export default module;
