import type { IndexingPlugin } from "frostbyte-sdk";
import { encodingUtils, viem } from "frostbyte-sdk";

// Teleporter contract address
const TELEPORTER_ADDRESS = "0x253b2784c75e510dd0ff1da844684a1ac0aa5fcf";

// Event topic signatures
const SEND_CROSS_CHAIN_MESSAGE_TOPIC = '0x2a211ad4a59ab9d003852404f9c57c690704ee755f3c79d2c2812ad32da99df8';
const RECEIVE_CROSS_CHAIN_MESSAGE_TOPIC = '0x292ee90bbaf70b5d4936025e09d56ba08f3e421156b6a568cf3c2840d9343e34';

interface ChainIntervalStats {
    send_count: number;
    receive_count: number;
    send_gas_used: bigint;
    receive_gas_used: bigint;
}

// Decode SendCrossChainMessage event
const decodeSendEvent = (log: viem.Log) => {
    // Teleporter SendCrossChainMessage event structure:
    // event SendCrossChainMessage(
    //     bytes32 indexed destinationBlockchainID,
    //     uint256 indexed messageID,
    //     TeleporterMessage message,
    //     TeleporterFeeInfo feeInfo
    // );

    // For now, we'll extract the destination blockchain ID from topics
    const destinationBlockchainID = log.topics[2]; // First indexed parameter - message id, second - destination blockchain id
    return {
        destinationBlockchainID: destinationBlockchainID || '0x0',
    };
};

// Decode ReceiveCrossChainMessage event  
const decodeReceiveEvent = (log: viem.Log) => {
    // Teleporter ReceiveCrossChainMessage event structure:
    // event ReceiveCrossChainMessage(
    //     bytes32 indexed sourceBlockchainID,
    //     uint256 indexed messageID,
    //     address indexed deliverer,
    //     address rewardRedeemer,
    //     TeleporterMessage message
    // );

    // Extract the source blockchain ID from topics
    const sourceBlockchainID = log.topics[2]; // First indexed parameter - message id, second - source blockchain id
    return {
        sourceBlockchainID: sourceBlockchainID || '0x0',
    };
};

const module: IndexingPlugin = {
    name: "icm_gas_usage",
    version: 8,
    usesTraces: false,
    filterEvents: [SEND_CROSS_CHAIN_MESSAGE_TOPIC, RECEIVE_CROSS_CHAIN_MESSAGE_TOPIC],

    // Initialize tables
    initialize: async (db) => {
        // Create table for per-chain per-interval statistics
        await db.execute(`
            CREATE TABLE IF NOT EXISTS icm_chain_interval_stats (
                chain_id VARCHAR(50),
                interval_ts INT,
                send_count INT NOT NULL DEFAULT 0,
                receive_count INT NOT NULL DEFAULT 0,
                send_gas_used VARCHAR(100) NOT NULL DEFAULT '0',
                receive_gas_used VARCHAR(100) NOT NULL DEFAULT '0',
                PRIMARY KEY (chain_id, interval_ts)
            )
        `);

        // Create index for queries
        try {
            await db.execute(`
                CREATE INDEX idx_icm_chain_interval_ts ON icm_chain_interval_stats(interval_ts)
            `);
        } catch (error: any) {
            // Ignore if already exists
            if (!error.message.includes('Duplicate key name')) {
                throw error;
            }
        }
    },

    // Process transactions
    handleTxBatch: async (db, blocksDb, batch) => {
        // Accumulate updates per chain per interval
        const updates = new Map<string, Map<number, ChainIntervalStats>>();

        for (const tx of batch.txs) {
            const gasUsed = BigInt(tx.receipt.gasUsed || '0');
            const intervalTs = Math.floor(tx.blockTs / 300) * 300; // 5 minutes

            // Check for both event types
            let hasSend = false;
            let hasReceive = false;

            for (const log of tx.receipt.logs) {
                if (log.address !== TELEPORTER_ADDRESS) continue;
                const topic = log.topics[0];
                if (topic === SEND_CROSS_CHAIN_MESSAGE_TOPIC) hasSend = true;
                if (topic === RECEIVE_CROSS_CHAIN_MESSAGE_TOPIC) hasReceive = true;
            }

            const gasPerEvent = hasSend && hasReceive ? gasUsed / 2n : gasUsed;

            for (const log of tx.receipt.logs) {
                if (log.address !== TELEPORTER_ADDRESS) continue;
                const topic = log.topics[0];

                let chainId: string;
                let isSend: boolean;

                if (topic === SEND_CROSS_CHAIN_MESSAGE_TOPIC) {
                    const event = decodeSendEvent(log as unknown as viem.Log);
                    chainId = encodingUtils.hexToCB58(event.destinationBlockchainID);
                    isSend = true;
                } else if (topic === RECEIVE_CROSS_CHAIN_MESSAGE_TOPIC) {
                    const event = decodeReceiveEvent(log as unknown as viem.Log);
                    chainId = encodingUtils.hexToCB58(event.sourceBlockchainID);
                    isSend = false;
                } else {
                    continue;
                }

                // Get or create chain map
                if (!updates.has(chainId)) {
                    updates.set(chainId, new Map());
                }
                const chainMap = updates.get(chainId)!;

                // Get or create interval stats
                if (!chainMap.has(intervalTs)) {
                    chainMap.set(intervalTs, {
                        send_count: 0,
                        receive_count: 0,
                        send_gas_used: 0n,
                        receive_gas_used: 0n
                    });
                }
                const stats = chainMap.get(intervalTs)!;

                if (isSend) {
                    stats.send_count += 1;
                    stats.send_gas_used += gasPerEvent;
                } else {
                    stats.receive_count += 1;
                    stats.receive_gas_used += gasPerEvent;
                }
            }
        }

        console.log(updates);

        // Update database
        for (const [chainId, chainMap] of updates) {
            for (const [intervalTs, stats] of chainMap) {
                await db.execute(`
                    INSERT INTO icm_chain_interval_stats 
                    (chain_id, interval_ts, send_count, receive_count, send_gas_used, receive_gas_used)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE
                        send_count = send_count + VALUES(send_count),
                        receive_count = receive_count + VALUES(receive_count),
                        send_gas_used = CAST(CAST(send_gas_used AS UNSIGNED) + CAST(VALUES(send_gas_used) AS UNSIGNED) AS CHAR),
                        receive_gas_used = CAST(CAST(receive_gas_used AS UNSIGNED) + CAST(VALUES(receive_gas_used) AS UNSIGNED) AS CHAR)
                `, [chainId, intervalTs, stats.send_count, stats.receive_count, stats.send_gas_used.toString(), stats.receive_gas_used.toString()]);
            }
        }

        // Optional logging
        if (updates.size > 0) {
            console.log(`ICM Burner: Updated stats for ${updates.size} chains across ${Array.from(updates.values()).reduce((sum, m) => sum + m.size, 0)} intervals`);
        }
    }
};

export default module;
