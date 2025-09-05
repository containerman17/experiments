import type { IndexingPlugin, TxBatch, BlocksDBHelper, betterSqlite3 } from "frostbyte-sdk";
import { dbFunctions } from "frostbyte-sdk";

interface ContractStats {
    messageCount: number;
    totalGas: bigint;
}

interface IcmMessagesByContractData {
    contractStats: Map<string, Map<number, ContractStats>>;
}

const SECONDS_PER_DAY = 86400;

// ICM/Teleporter event signatures
const SEND_CROSS_CHAIN_MESSAGE_TOPIC = '0x2a211ad4a59ab9d003852404f9c57c690704ee755f3c79d2c2812ad32da99df8';
const RECEIVE_CROSS_CHAIN_MESSAGE_TOPIC = '0x292ee90bbaf70b5d4936025e09d56ba08f3e421156b6a568cf3c2840d9343e34';

const module: IndexingPlugin<IcmMessagesByContractData> = {
    name: "icm_messages_by_contract",
    version: 3,
    usesTraces: false,
    filterEvents: [SEND_CROSS_CHAIN_MESSAGE_TOPIC, RECEIVE_CROSS_CHAIN_MESSAGE_TOPIC],


    initialize: (db: betterSqlite3.Database) => {
        // Create table for ICM messages by contract
        db.exec(`
            CREATE TABLE IF NOT EXISTS icm_messages_by_contract (
                contract TEXT,
                timestamp INTEGER,
                message_count INTEGER NOT NULL DEFAULT 0,
                total_gas_cost BLOB NOT NULL,
                PRIMARY KEY (contract, timestamp)
            )
        `);
    },

    extractData: (batch: TxBatch): IcmMessagesByContractData => {
        // Accumulate stats in memory
        const contractStats = new Map<string, Map<number, ContractStats>>();

        for (const { tx, receipt, blockTs } of batch.txs) {
            // Check if this transaction has any ICM-related events
            const hasIcmEvents = receipt.logs?.some(log =>
                log.topics?.[0] && (
                    log.topics[0] === SEND_CROSS_CHAIN_MESSAGE_TOPIC ||
                    log.topics[0] === RECEIVE_CROSS_CHAIN_MESSAGE_TOPIC
                )
            ) || false;

            if (!hasIcmEvents || !tx.to) continue; // Skip if no ICM events or no contract called

            // Round timestamp to day
            const dayTimestamp = Math.floor(blockTs / SECONDS_PER_DAY) * SECONDS_PER_DAY;
            const gasUsed = BigInt(receipt.gasUsed || '0');

            // Count ICM events in this transaction
            const icmEventCount = receipt.logs?.filter(l =>
                l.topics?.[0] && (
                    l.topics[0] === SEND_CROSS_CHAIN_MESSAGE_TOPIC ||
                    l.topics[0] === RECEIVE_CROSS_CHAIN_MESSAGE_TOPIC
                )
            ).length || 0;

            if (icmEventCount === 0) continue;

            // Track the contract that was called (tx.to)
            const contractAddress = tx.to;

            if (!contractStats.has(contractAddress)) {
                contractStats.set(contractAddress, new Map());
            }
            const contractDayMap = contractStats.get(contractAddress)!;

            if (!contractDayMap.has(dayTimestamp)) {
                contractDayMap.set(dayTimestamp, {
                    messageCount: 0,
                    totalGas: 0n
                });
            }
            const contractDayStats = contractDayMap.get(dayTimestamp)!;
            contractDayStats.messageCount += icmEventCount;
            contractDayStats.totalGas += gasUsed;
        }

        return {
            contractStats
        };
    },

    saveExtractedData: (
        db: betterSqlite3.Database,
        blocksDb: BlocksDBHelper,
        data: IcmMessagesByContractData
    ) => {
        const { contractStats } = data;

        // Skip if no data to save
        if (contractStats.size === 0) return;

        // Prepare statement for batch insert/update
        const insertContractStmt = db.prepare(`
            INSERT INTO icm_messages_by_contract (contract, timestamp, message_count, total_gas_cost)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(contract, timestamp) DO UPDATE SET
                message_count = message_count + excluded.message_count,
                total_gas_cost = UINT256_ADD(total_gas_cost, excluded.total_gas_cost)
        `);

        // Process contract stats
        let contractUpdates = 0;

        for (const [contract, dayMap] of contractStats) {
            for (const [timestamp, stats] of dayMap) {
                insertContractStmt.run(
                    contract,
                    timestamp,
                    stats.messageCount,
                    dbFunctions.uint256ToBlob(stats.totalGas)
                );
                contractUpdates++;
            }
        }

        console.log(`ICM Messages: Updated ${contractUpdates} contract entries`);
    }
};

export default module;
