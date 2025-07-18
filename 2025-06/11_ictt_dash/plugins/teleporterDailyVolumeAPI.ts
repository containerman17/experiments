import type { ApiPlugin } from "frostbyte-sdk";

type DailyVolume = {
    timestamp: number;
    date: string;
    messageCount: number;
}

type ChainPairKey = `${string}->${string}`;

interface MessageCountRow {
    is_outgoing: number;
    other_chain_id: string;
    message_count: number;
}

const module: ApiPlugin = {
    name: "teleporter_daily_volume",
    requiredIndexers: ["teleporter_messages"],

    registerRoutes: (app, dbCtx) => {
        app.get('/api/metrics/dailyMessageVolume', {
            schema: {
                querystring: {
                    type: 'object',
                    properties: {
                        days: {
                            type: 'integer',
                            minimum: 1,
                            maximum: 100,
                            default: 7
                        }
                    }
                },
                response: {
                    200: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                timestamp: { type: 'number' },
                                date: { type: 'string' },
                                messageCount: { type: 'number' }
                            },
                            required: ['timestamp', 'date', 'messageCount']
                        }
                    }
                }
            }
        }, async (request, reply) => {
            const { days = 7 } = request.query as { days?: number };

            // Get current timestamp in seconds
            const now = Math.floor(Date.now() / 1000);
            const configs = dbCtx.getAllChainConfigs();

            // Create array for daily volumes
            const dailyVolumes: DailyVolume[] = [];

            // Process each 24-hour period
            for (let i = 0; i < days; i++) {
                const endTime = now - (i * 86400); // 86400 seconds = 24 hours
                const startTime = endTime - 86400;

                // Map to store message counts per chain pair for deduplication
                const pairCounts = new Map<ChainPairKey, {
                    incomingCount?: number;
                    outgoingCount?: number;
                }>();

                // Query each chain's database
                for (const config of configs) {
                    try {
                        const indexerConn = await dbCtx.getIndexerDbConnection(config.evmChainId, "teleporter_messages");

                        // Query grouped counts for messages in this time period
                        const [rows] = await indexerConn.execute(`
                            SELECT
                                is_outgoing,
                                other_chain_id,
                                COUNT(*) as message_count
                            FROM teleporter_messages
                            WHERE block_timestamp >= ? AND block_timestamp < ?
                            GROUP BY is_outgoing, other_chain_id
                        `, [startTime, endTime]);
                        const results = rows as MessageCountRow[];

                        // Process results for deduplication
                        for (const row of results) {
                            if (row.is_outgoing === 1) {
                                // Outgoing: from this chain to other chain
                                const key: ChainPairKey = `${config.blockchainId}->${row.other_chain_id}`;
                                const existing = pairCounts.get(key) || {};
                                existing.outgoingCount = row.message_count;
                                pairCounts.set(key, existing);
                            } else {
                                // Incoming: from other chain to this chain
                                const key: ChainPairKey = `${row.other_chain_id}->${config.blockchainId}`;
                                const existing = pairCounts.get(key) || {};
                                existing.incomingCount = row.message_count;
                                pairCounts.set(key, existing);
                            }
                        }
                    } catch (error) {
                        // Chain might not have the teleporter_messages indexer
                        console.log(`Skipping chain ${config.chainName} - teleporter indexer not found`);
                    }
                }

                // Calculate total messages for this day, preferring incoming counts
                let totalMessages = 0;
                for (const [_, data] of pairCounts) {
                    // Prefer incoming count over outgoing count to avoid double counting
                    totalMessages += data.incomingCount ?? data.outgoingCount ?? 0;
                }

                // Create date string for this period
                const dateObj = new Date(endTime * 1000);
                const dateStr = dateObj.toISOString().split('T')[0]!; // YYYY-MM-DD format

                dailyVolumes.push({
                    timestamp: endTime,
                    date: dateStr,
                    messageCount: totalMessages
                });
            }

            return reply.send(dailyVolumes);
        });
    }
};

export default module;
