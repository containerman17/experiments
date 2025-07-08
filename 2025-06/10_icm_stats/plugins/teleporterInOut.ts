import { type IndexerModule, prepQueryCached, normalizeTimestamp, getPreviousTimestamp, getTimeIntervalFromString } from "frostbyte-sdk";
import { utils } from "@avalabs/avalanchejs";

// Teleporter contract address
const TELEPORTER_ADDRESS = "0x253b2784c75e510dd0ff1da844684a1ac0aa5fcf";

// Event topic signatures
const SEND_CROSS_CHAIN_MESSAGE_TOPIC = '0x2a211ad4a59ab9d003852404f9c57c690704ee755f3c79d2c2812ad32da99df8';
const RECEIVE_CROSS_CHAIN_MESSAGE_TOPIC = '0x292ee90bbaf70b5d4936025e09d56ba08f3e421156b6a568cf3c2840d9343e34';

// Time interval constants
const TIME_INTERVAL_HOUR = 0;
const TIME_INTERVAL_DAY = 1;
const TIME_INTERVAL_WEEK = 2;
const TIME_INTERVAL_MONTH = 3;

const hexToBase58Cache: Record<string, string> = {};
const hexToBase58Cached = (hex: string) => {
    if (hexToBase58Cache[hex]) {
        return hexToBase58Cache[hex];
    }
    const base58 = utils.base58check.encode(Buffer.from(hex, 'hex'));
    hexToBase58Cache[hex] = base58;
    return base58;
}

const module: IndexerModule = {
    name: "teleporterInOut",
    version: 1,
    usesTraces: false,

    // Reset all plugin data
    wipe: (db) => {
        db.exec(`DROP TABLE IF EXISTS teleporter_stats`);
    },

    // Initialize tables
    initialize: (db) => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS teleporter_stats (
                direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
                other_chain_id TEXT NOT NULL,
                time_interval INTEGER NOT NULL CHECK (time_interval IN (0, 1, 2, 3)),
                timestamp INTEGER NOT NULL,
                msg_count INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (direction, other_chain_id, time_interval, timestamp)
            )
        `);

        // Create a single composite index on all fields except count
        db.exec(`
            CREATE INDEX IF NOT EXISTS idx_teleporter_stats_composite 
            ON teleporter_stats(direction, other_chain_id, time_interval, timestamp);
        `);
    },

    // Process transactions
    handleTxBatch: (db, blocksDb, batch) => {
        // Buffer to accumulate stats in memory
        // Key format: "direction|chainId|interval|timestamp"
        const statsBuffer = new Map<string, number>();

        for (const tx of batch.txs) {
            // Get the block timestamp for this transaction
            const timestamp = tx.blockTs;

            for (const log of tx.receipt.logs) {
                if (log.address !== TELEPORTER_ADDRESS) {
                    continue;
                }

                const eventTopic = log.topics[0];
                let direction: string;
                let chainId: string;

                if (eventTopic === SEND_CROSS_CHAIN_MESSAGE_TOPIC) {
                    // Outgoing message
                    direction = 'outgoing';
                } else if (eventTopic === RECEIVE_CROSS_CHAIN_MESSAGE_TOPIC) {
                    // Incoming message
                    direction = 'incoming';
                } else {
                    continue;
                }

                chainId = hexToBase58Cached(log.topics[1]);

                // Insert/update rows for each time interval
                const timeIntervals = [TIME_INTERVAL_HOUR, TIME_INTERVAL_DAY, TIME_INTERVAL_WEEK, TIME_INTERVAL_MONTH];

                for (const interval of timeIntervals) {
                    const normalizedTimestamp = normalizeTimestamp(timestamp, interval);
                    const key = `${direction}|${chainId}|${interval}|${normalizedTimestamp}`;

                    statsBuffer.set(key, (statsBuffer.get(key) || 0) + 1);
                }
            }
        }

        // Bulk upsert all accumulated stats
        if (statsBuffer.size > 0) {
            const upsertStmt = prepQueryCached(db, `
                INSERT INTO teleporter_stats (
                    direction, other_chain_id, time_interval, timestamp, msg_count
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(direction, other_chain_id, time_interval, timestamp) 
                DO UPDATE SET msg_count = msg_count + excluded.msg_count
            `);

            for (const [key, count] of statsBuffer) {
                const [direction, chainId, interval, timestamp] = key.split('|');
                upsertStmt.run(
                    direction,
                    chainId,
                    parseInt(interval),
                    parseInt(timestamp),
                    count
                );
            }
        }
    },

    // No API endpoints for now
    registerRoutes: (app, dbCtx) => {
        // API endpoints will be added later to return arrays of [timestamp, value] based on period
        app.get('/teleporter/leaderBoard/day', {
            schema: {
                response: {
                    200: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                fromChainId: { type: 'string' },
                                toChainId: { type: 'string' },
                                messageCount: { type: 'number' }
                            },
                            required: ['fromChainId', 'toChainId', 'messageCount']
                        }
                    }
                }
            }
        }, async (request, reply) => {
            const configs = dbCtx.getAllChainConfigs();

            // Map to store chain pair message counts
            // Key: "fromChainId|toChainId", Value: { count, isIncoming }
            const chainPairCounts = new Map<string, { count: number, isIncoming: boolean }>();

            // Get current timestamp normalized to day
            const currentDayTimestamp = normalizeTimestamp(Math.floor(Date.now() / 1000), TIME_INTERVAL_DAY);

            // Iterate through all chains
            for (const config of configs) {
                const chainId = config.blockchainId;
                const db = dbCtx.indexerDbFactory(config.evmChainId);

                // Query outgoing messages for current day
                const outgoingStmt = prepQueryCached(db, `
                    SELECT other_chain_id, msg_count 
                    FROM teleporter_stats 
                    WHERE direction = 'outgoing' 
                    AND time_interval = ? 
                    AND timestamp = ?
                `);

                const outgoingRows = outgoingStmt.all(TIME_INTERVAL_DAY, currentDayTimestamp) as Array<{
                    other_chain_id: string;
                    msg_count: number;
                }>;

                for (const row of outgoingRows) {
                    const key = `${chainId}|${row.other_chain_id}`;
                    const existing = chainPairCounts.get(key);

                    // Only add outgoing if no incoming exists for this pair
                    if (!existing || !existing.isIncoming) {
                        chainPairCounts.set(key, { count: row.msg_count, isIncoming: false });
                    }
                }

                // Query incoming messages for current day
                const incomingStmt = prepQueryCached(db, `
                    SELECT other_chain_id, msg_count 
                    FROM teleporter_stats 
                    WHERE direction = 'incoming' 
                    AND time_interval = ? 
                    AND timestamp = ?
                `);

                const incomingRows = incomingStmt.all(TIME_INTERVAL_DAY, currentDayTimestamp) as Array<{
                    other_chain_id: string;
                    msg_count: number;
                }>;

                for (const row of incomingRows) {
                    const key = `${row.other_chain_id}|${chainId}`;
                    // Always prefer incoming counts
                    chainPairCounts.set(key, { count: row.msg_count, isIncoming: true });
                }
            }

            // Convert map to response array
            const result = Array.from(chainPairCounts.entries()).map(([key, value]) => {
                const [fromChainId, toChainId] = key.split('|');
                return {
                    fromChainId,
                    toChainId,
                    messageCount: value.count
                };
            });

            // Sort by message count descending
            result.sort((a, b) => b.messageCount - a.messageCount);

            return reply.send(result);
        });
    }
};

export default module;
