import type { IndexingPlugin, TxBatch, BlocksDBHelper, betterSqlite3 } from "frostbyte-sdk";
import { dbFunctions } from "frostbyte-sdk";

interface AddressGasStats {
    txCount: number;
    totalGas: bigint;
}

interface GasBurnedByAddressData {
    senderStats: Map<string, Map<number, AddressGasStats>>;
    receiverStats: Map<string, Map<number, AddressGasStats>>;
}

const SECONDS_PER_DAY = 86400;

const module: IndexingPlugin<GasBurnedByAddressData> = {
    name: "gas_burned_by_address",
    version: 4,
    usesTraces: false,

    initialize: (db: betterSqlite3.Database) => {
        // Create table for gas burned by sender
        db.exec(`
            CREATE TABLE IF NOT EXISTS gas_burned_by_sender (
                address TEXT,
                timestamp INTEGER,
                tx_count INTEGER NOT NULL DEFAULT 0,
                total_gas_cost BLOB NOT NULL,
                PRIMARY KEY (address, timestamp)
            )
        `);

        // Create table for gas burned by receiver
        db.exec(`
            CREATE TABLE IF NOT EXISTS gas_burned_by_receiver (
                address TEXT,
                timestamp INTEGER,
                tx_count INTEGER NOT NULL DEFAULT 0,
                total_gas_cost BLOB NOT NULL,
                PRIMARY KEY (address, timestamp)
            )
        `);
    },

    extractData: (batch: TxBatch): GasBurnedByAddressData => {
        // Accumulate stats in memory
        const senderStats = new Map<string, Map<number, AddressGasStats>>();
        const receiverStats = new Map<string, Map<number, AddressGasStats>>();

        for (const { tx, receipt, blockTs } of batch.txs) {
            // Round timestamp to day
            const dayTimestamp = Math.floor(blockTs / SECONDS_PER_DAY) * SECONDS_PER_DAY;
            const gasUsed = BigInt(receipt.gasUsed || '0');

            // Track sender stats
            const fromAddress = tx.from;
            if (!senderStats.has(fromAddress)) {
                senderStats.set(fromAddress, new Map());
            }
            const senderDayMap = senderStats.get(fromAddress)!;

            if (!senderDayMap.has(dayTimestamp)) {
                senderDayMap.set(dayTimestamp, {
                    txCount: 0,
                    totalGas: 0n
                });
            }
            const senderDayStats = senderDayMap.get(dayTimestamp)!;
            senderDayStats.txCount += 1;
            senderDayStats.totalGas += gasUsed;

            // Track receiver stats (if receiver exists)
            const toAddress = tx.to;
            if (toAddress) {
                if (!receiverStats.has(toAddress)) {
                    receiverStats.set(toAddress, new Map());
                }
                const receiverDayMap = receiverStats.get(toAddress)!;

                if (!receiverDayMap.has(dayTimestamp)) {
                    receiverDayMap.set(dayTimestamp, {
                        txCount: 0,
                        totalGas: 0n
                    });
                }
                const receiverDayStats = receiverDayMap.get(dayTimestamp)!;
                receiverDayStats.txCount += 1;
                receiverDayStats.totalGas += gasUsed;
            }
        }

        return {
            senderStats,
            receiverStats
        };
    },

    saveExtractedData: (
        db: betterSqlite3.Database,
        blocksDb: BlocksDBHelper,
        data: GasBurnedByAddressData
    ) => {
        const { senderStats, receiverStats } = data;

        // Skip if no data to save
        if (senderStats.size === 0 && receiverStats.size === 0) return;

        // Prepare statements for batch insert/update
        const insertSenderStmt = db.prepare(`
            INSERT INTO gas_burned_by_sender (address, timestamp, tx_count, total_gas_cost)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(address, timestamp) DO UPDATE SET
                tx_count = tx_count + excluded.tx_count,
                total_gas_cost = UINT256_ADD(total_gas_cost, excluded.total_gas_cost)
        `);

        const insertReceiverStmt = db.prepare(`
            INSERT INTO gas_burned_by_receiver (address, timestamp, tx_count, total_gas_cost)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(address, timestamp) DO UPDATE SET
                tx_count = tx_count + excluded.tx_count,
                total_gas_cost = UINT256_ADD(total_gas_cost, excluded.total_gas_cost)
        `);

        // Process sender stats
        let senderUpdates = 0;

        for (const [address, dayMap] of senderStats) {
            for (const [timestamp, stats] of dayMap) {
                insertSenderStmt.run(
                    address,
                    timestamp,
                    stats.txCount,
                    dbFunctions.uint256ToBlob(stats.totalGas)
                );
                senderUpdates++;
            }
        }

        // Process receiver stats
        let receiverUpdates = 0;
        for (const [address, dayMap] of receiverStats) {
            for (const [timestamp, stats] of dayMap) {
                insertReceiverStmt.run(
                    address,
                    timestamp,
                    stats.txCount,
                    dbFunctions.uint256ToBlob(stats.totalGas)
                );
                receiverUpdates++;
            }
        }

        console.log(`Gas Burned: Updated ${senderUpdates} sender entries and ${receiverUpdates} receiver entries`);
    }
};

export default module;
