import type { IndexingPlugin, TxBatch, BlocksDBHelper, betterSqlite3 } from "frostbyte-sdk";
import { dbFunctions } from "frostbyte-sdk";

interface InteractionStats {
    txCount: number;
    totalGasCost: bigint;
}

interface DailyInteractionsData {
    interactions: Map<string, Map<number, InteractionStats>>; // key: "from-to", value: Map<timestamp, stats>
}

const SECONDS_PER_DAY = 86400;

const module: IndexingPlugin<DailyInteractionsData> = {
    name: "daily_interactions",
    version: 1,
    usesTraces: false,

    initialize: (db: betterSqlite3.Database) => {
        // Create table for daily interactions between addresses
        db.exec(`
            CREATE TABLE IF NOT EXISTS daily_interactions (
                from_address TEXT NOT NULL,
                to_address TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                tx_count INTEGER NOT NULL DEFAULT 0,
                total_gas_cost BLOB NOT NULL,
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
        // Accumulate stats in memory
        const interactions = new Map<string, Map<number, InteractionStats>>();

        for (const { tx, receipt, blockTs } of batch.txs) {
            // Skip transactions without a recipient (contract creation)
            if (!tx.to) continue;

            // Round timestamp to day
            const dayTimestamp = Math.floor(blockTs / SECONDS_PER_DAY) * SECONDS_PER_DAY;
            const gasUsed = BigInt(receipt.gasUsed || '0');

            // Create interaction key from sender to recipient
            const fromAddress = tx.from;
            const toAddress = tx.to;
            const interactionKey = `${fromAddress}-${toAddress}`;

            if (!interactions.has(interactionKey)) {
                interactions.set(interactionKey, new Map());
            }
            const interactionDayMap = interactions.get(interactionKey)!;

            if (!interactionDayMap.has(dayTimestamp)) {
                interactionDayMap.set(dayTimestamp, {
                    txCount: 0,
                    totalGasCost: 0n
                });
            }
            const interactionDayStats = interactionDayMap.get(dayTimestamp)!;
            interactionDayStats.txCount += 1;
            interactionDayStats.totalGasCost += gasUsed;
        }

        return {
            interactions
        };
    },

    saveExtractedData: (
        db: betterSqlite3.Database,
        blocksDb: BlocksDBHelper,
        data: DailyInteractionsData
    ) => {
        const { interactions } = data;

        // Skip if no data to save
        if (interactions.size === 0) return;

        // Prepare statement for batch insert/update
        const insertInteractionStmt = db.prepare(`
            INSERT INTO daily_interactions (from_address, to_address, timestamp, tx_count, total_gas_cost)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(from_address, to_address, timestamp) DO UPDATE SET
                tx_count = tx_count + excluded.tx_count,
                total_gas_cost = UINT256_ADD(total_gas_cost, excluded.total_gas_cost)
        `);

        // Process interaction stats
        let interactionUpdates = 0;

        for (const [interactionKey, dayMap] of interactions) {
            const [fromAddress, toAddress] = interactionKey.split('-');

            for (const [timestamp, stats] of dayMap) {
                insertInteractionStmt.run(
                    fromAddress,
                    toAddress,
                    timestamp,
                    stats.txCount,
                    dbFunctions.uint256ToBlob(stats.totalGasCost)
                );
                interactionUpdates++;
            }
        }

        console.log(`Daily Interactions: Updated ${interactionUpdates} interaction entries`);
    }
};

export default module;
