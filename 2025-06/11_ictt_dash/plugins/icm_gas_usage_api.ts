import type { ApiPlugin } from "frostbyte-sdk";

type IcmGasUsageStats = {
    name: string;
    blockchainId: string;
    evmChainId: number;
    chainId: string;
    sendCount: number;
    receiveCount: number;
    sendGasUsed: string;
    receiveGasUsed: string;
    totalGasUsed: string;
    intervalTs: number;
}

interface ChainStatsResult {
    chain_id: string;
    interval_ts: number;
    send_count: number;
    receive_count: number;
    send_gas_used: string;
    receive_gas_used: string;
}

const module: ApiPlugin = {
    name: "icm_gas_usage_api",
    requiredIndexers: ['icm_gas_usage'],

    registerRoutes: (app, dbCtx) => {
        app.get<{
            Params: { evmChainId: string };
            Querystring: {
                period?: '1d' | '7d' | '30d' | '1h' | 'all';
                count?: number;
            }
        }>('/api/:evmChainId/stats/icm-gas-usage', {
            schema: {
                params: {
                    type: 'object',
                    properties: {
                        evmChainId: { type: 'string' }
                    },
                    required: ['evmChainId']
                },
                querystring: {
                    type: 'object',
                    properties: {
                        period: { type: 'string', enum: ['1d', '7d', '30d', '1h', 'all'], default: '1d' },
                        count: { type: 'number', minimum: 1, maximum: 100, default: 50 }
                    },
                    required: []
                },
                response: {
                    200: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string' },
                                blockchainId: { type: 'string' },
                                evmChainId: { type: 'number' },
                                chainId: { type: 'string' },
                                sendCount: { type: 'number' },
                                receiveCount: { type: 'number' },
                                sendGasUsed: { type: 'string' },
                                receiveGasUsed: { type: 'string' },
                                totalGasUsed: { type: 'string' },
                                intervalTs: { type: 'number' }
                            },
                            required: ['name', 'blockchainId', 'evmChainId', 'chainId', 'sendCount', 'receiveCount', 'sendGasUsed', 'receiveGasUsed', 'totalGasUsed', 'intervalTs']
                        }
                    }
                }
            }
        }, async (request, reply) => {
            const evmChainId = parseInt(request.params.evmChainId);
            const config = dbCtx.getChainConfig(evmChainId);

            if (!config) {
                return reply.code(404).send({ error: 'Chain not found' });
            }

            const results: IcmGasUsageStats[] = [];

            // Get current timestamp in seconds
            const now = Math.floor(Date.now() / 1000);
            const period = request.query.period || '1d';
            const count = request.query.count || 50;

            let periodSeconds: number | null = null;
            let since: number | null = null;

            if (period !== 'all') {
                if (period === '7d') periodSeconds = 86400 * 7;
                else if (period === '30d') periodSeconds = 86400 * 30;
                else if (period === '1h') periodSeconds = 3600;
                else periodSeconds = 86400; // default: 1 day
                since = now - periodSeconds;
            }

            // Get the latest interval timestamp to calculate the range for filling gaps
            const intervalSize = 300; // 5 minutes
            const latestIntervalTs = Math.floor(now / intervalSize) * intervalSize;

            const indexerConn = await dbCtx.getIndexerDbConnection(config.evmChainId, 'icm_gas_usage');

            // Build query based on period
            let query = `
                SELECT chain_id, interval_ts, send_count, receive_count, send_gas_used, receive_gas_used
                FROM icm_chain_interval_stats
            `;
            const params: any[] = [];

            if (since !== null) {
                query += ` WHERE interval_ts >= ?`;
                params.push(since);
            }

            query += ` ORDER BY interval_ts DESC LIMIT ?`;
            params.push(count);

            const [rows] = await indexerConn.execute(query, params);
            const results_raw = rows as ChainStatsResult[];

            // Create a map to store existing data
            const dataMap = new Map<string, Map<number, ChainStatsResult>>();
            for (const row of results_raw) {
                if (!dataMap.has(row.chain_id)) {
                    dataMap.set(row.chain_id, new Map());
                }
                dataMap.get(row.chain_id)!.set(row.interval_ts, row);
            }

            // Generate time intervals to fill gaps
            const intervals: number[] = [];
            if (since !== null) {
                for (let ts = latestIntervalTs; ts >= since && intervals.length < count; ts -= intervalSize) {
                    intervals.push(ts);
                }
            } else {
                // For 'all' period, get existing intervals and fill gaps between them
                const existingIntervals = new Set(results_raw.map(r => r.interval_ts));
                if (existingIntervals.size > 0) {
                    const intervalArray = Array.from(existingIntervals);
                    const minTs = Math.min(...intervalArray);
                    const maxTs = Math.max(...intervalArray);
                    for (let ts = maxTs; ts >= minTs && intervals.length < count; ts -= intervalSize) {
                        intervals.push(ts);
                    }
                }
            }

            // Get all unique chain IDs that have any data
            const allChainIds = new Set(results_raw.map(r => r.chain_id));

            // Fill gaps with zero values
            for (const chainId of Array.from(allChainIds)) {
                const chainData = dataMap.get(chainId) || new Map();

                for (const intervalTs of intervals) {
                    const existing = chainData.get(intervalTs);
                    const row = existing || {
                        chain_id: chainId,
                        interval_ts: intervalTs,
                        send_count: 0,
                        receive_count: 0,
                        send_gas_used: '0',
                        receive_gas_used: '0'
                    };

                    const sendGasUsed = BigInt(row.send_gas_used);
                    const receiveGasUsed = BigInt(row.receive_gas_used);
                    const totalGasUsed = sendGasUsed + receiveGasUsed;

                    results.push({
                        name: config.chainName,
                        blockchainId: config.blockchainId,
                        evmChainId: config.evmChainId,
                        chainId: row.chain_id,
                        sendCount: row.send_count,
                        receiveCount: row.receive_count,
                        sendGasUsed: row.send_gas_used,
                        receiveGasUsed: row.receive_gas_used,
                        totalGasUsed: totalGasUsed.toString(),
                        intervalTs: row.interval_ts
                    });
                }
            }

            // Sort by timestamp descending, then by total gas used descending
            results.sort((a, b) => {
                if (a.intervalTs !== b.intervalTs) {
                    return b.intervalTs - a.intervalTs;
                }
                return Number(BigInt(b.totalGasUsed) - BigInt(a.totalGasUsed));
            });

            return reply.send(results.slice(0, count));
        });
    }
};

export default module;
