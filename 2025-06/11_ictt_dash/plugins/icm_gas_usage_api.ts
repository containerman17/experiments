import type { ApiPlugin } from "frostbyte-sdk";

type IcmGasUsageStats = {
    name: string;
    blockchainId: string;
    evmChainId: number;
    chainId: string;
    sendCount: number;
    receiveCount: number;
    sendGasCost: number;  // Changed to number for float representation
    receiveGasCost: number;  // Changed to number for float representation
    totalGasCost: number;  // Changed to number for float representation
    intervalTs: number;
}

type IcmGasUsageValue = {
    sendCount: number;
    receiveCount: number;
    sendGasCost: number;  // Changed to number for float representation
    receiveGasCost: number;  // Changed to number for float representation  
    totalGasCost: number;  // Changed to number for float representation
    intervalTs: number;
}

type IcmGasUsageChainData = {
    name: string;
    evmChainId: number;
    values: IcmGasUsageValue[];
}

interface ChainStatsResult {
    other_chain_id: string;
    interval_ts: number;
    send_count: number;
    receive_count: number;
    send_gas_cost: string;  // DECIMAL comes as string from MySQL
    receive_gas_cost: string;  // DECIMAL comes as string from MySQL
}

const module: ApiPlugin = {
    name: "icm_gas_usage_api",
    requiredIndexers: ['icm_gas_usage'],

    registerRoutes: (app, dbCtx) => {
        app.get<{
            Params: { evmChainId: string };
            Querystring: {
                period?: '1d' | '7d' | '30d' | '1h';
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
                        period: { type: 'string', enum: ['1d', '7d', '30d', '1h'], default: '1d' },
                        count: { type: 'number', minimum: 1, maximum: 100, default: 50 }
                    },
                    required: []
                },
                response: {
                    200: {
                        type: 'object',
                        additionalProperties: {
                            type: 'object',
                            properties: {
                                name: { type: 'string' },
                                evmChainId: { type: 'number' },
                                values: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            sendCount: { type: 'number' },
                                            receiveCount: { type: 'number' },
                                            sendGasCost: { type: 'number' },  // Changed to number
                                            receiveGasCost: { type: 'number' },  // Changed to number
                                            totalGasCost: { type: 'number' },  // Changed to number
                                            intervalTs: { type: 'number' }
                                        },
                                        required: ['sendCount', 'receiveCount', 'sendGasCost', 'receiveGasCost', 'totalGasCost', 'intervalTs']
                                    }
                                }
                            },
                            required: ['name', 'evmChainId', 'values']
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

            // Get current timestamp in seconds
            const now = Math.floor(Date.now() / 1000);
            const period = request.query.period || '1d';
            const count = request.query.count || 50;

            let periodSeconds: number;
            if (period === '7d') periodSeconds = 86400 * 7;
            else if (period === '30d') periodSeconds = 86400 * 30;
            else if (period === '1h') periodSeconds = 3600;
            else if (period === '1d') periodSeconds = 86400;
            else throw new Error(`Invalid period: ${period}`);

            const since = now - count * periodSeconds;

            const indexerConn = await dbCtx.getIndexerDbConnection(config.evmChainId, 'icm_gas_usage');

            // Generate intervals using MySQL aggregation with sliding windows relative to 'now'
            const query = `
                SELECT 
                    other_chain_id,
                    FLOOR((? - interval_ts) / ?) as interval_index,
                    SUM(send_count) as send_count,
                    SUM(receive_count) as receive_count,
                    SUM(send_gas_cost) as send_gas_cost,
                    SUM(receive_gas_cost) as receive_gas_cost
                FROM icm_chain_interval_stats
                WHERE interval_ts >= ? AND interval_ts <= ?
                GROUP BY other_chain_id, interval_index
                ORDER BY other_chain_id, interval_index
            `;

            const [rows] = await indexerConn.execute(query, [now, periodSeconds, since, now]);
            const results = rows as Array<{
                other_chain_id: string;
                interval_index: number;
                send_count: number;
                receive_count: number;
                send_gas_cost: string;
                receive_gas_cost: string;
            }>;

            // Group results by chain
            const resultsByChain: Record<string, IcmGasUsageChainData> = {};

            // Initialize all intervals for all chains
            const allChains = [...new Set(results.map(r => r.other_chain_id))];

            for (const otherChainId of allChains) {
                const chainConfig = dbCtx.getChainConfig(otherChainId) || {
                    chainName: "Unknown",
                    evmChainId: 0
                };

                resultsByChain[otherChainId] = {
                    name: chainConfig.chainName,
                    evmChainId: chainConfig.evmChainId,
                    values: []
                };

                // Create a map for quick lookup by interval index
                const chainResults = results.filter(r => r.other_chain_id === otherChainId);
                const resultMap = new Map(chainResults.map(r => [r.interval_index, r]));

                // Generate all intervals, filling with zeros where no data exists
                for (let i = 0; i < count; i++) {
                    const intervalEnd = now - i * periodSeconds;
                    const intervalStart = intervalEnd - periodSeconds;
                    const data = resultMap.get(i);

                    if (data) {
                        // Values are already in ETH/AVAX from the database
                        const sendGasCost = parseFloat(data.send_gas_cost);
                        const receiveGasCost = parseFloat(data.receive_gas_cost);
                        const totalGasCost = sendGasCost + receiveGasCost;

                        resultsByChain[otherChainId].values.push({
                            sendCount: data.send_count,
                            receiveCount: data.receive_count,
                            sendGasCost: sendGasCost,
                            receiveGasCost: receiveGasCost,
                            totalGasCost: totalGasCost,
                            intervalTs: intervalStart
                        });
                    } else {
                        resultsByChain[otherChainId].values.push({
                            sendCount: 0,
                            receiveCount: 0,
                            sendGasCost: 0,
                            receiveGasCost: 0,
                            totalGasCost: 0,
                            intervalTs: intervalStart
                        });
                    }
                }
            }

            return reply.send(resultsByChain);
        });
    }
};

export default module;
