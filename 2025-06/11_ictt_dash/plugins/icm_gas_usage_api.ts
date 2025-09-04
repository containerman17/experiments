import { type ApiPlugin, dbFunctions } from "frostbyte-sdk";

type IcmGasUsageStats = {
    chainName: string;
    chainBlockchainId: string;
    otherChainName: string;
    otherChainBlockchainId: string;
    sendCount: number;
    receiveCount: number;
    sendGasCost: number;
    receiveGasCost: number;
    totalCount: number;
    totalGasCost: number;
}

interface ChainStatsResult {
    other_chain_id: string;
    send_count: number;
    receive_count: number;
    send_gas_cost: Buffer | null;
    receive_gas_cost: Buffer | null;
}

const module: ApiPlugin = {
    name: "icm_gas_usage_api",
    requiredIndexers: ['icm_gas_usage'],
    version: 1,

    registerRoutes: (app, dbCtx) => {
        app.get<{
            Querystring: {
                chain?: string;
                startTs?: number;
                endTs?: number;
            }
        }>('/api/global/icm-gas-usage', {
            schema: {
                querystring: {
                    type: 'object',
                    properties: {
                        chain: { type: 'string' },
                        startTs: { type: 'number' },
                        endTs: { type: 'number' }
                    },
                    required: []
                },
                response: {
                    200: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                chainName: { type: 'string' },
                                chainBlockchainId: { type: 'string' },
                                otherChainName: { type: 'string' },
                                otherChainBlockchainId: { type: 'string' },
                                sendCount: { type: 'number' },
                                receiveCount: { type: 'number' },
                                sendGasCost: { type: 'number' },
                                receiveGasCost: { type: 'number' },
                                totalCount: { type: 'number' },
                                totalGasCost: { type: 'number' }
                            },
                            required: ['chainName', 'chainBlockchainId', 'otherChainName', 'otherChainBlockchainId',
                                'sendCount', 'receiveCount', 'sendGasCost', 'receiveGasCost', 'totalCount', 'totalGasCost']
                        }
                    }
                }
            }
        }, async (request, reply) => {
            const { chain, startTs, endTs } = request.query;

            // Get all chains
            const chains = dbCtx.getAllChainConfigs();
            const selectedChain = chain ? chains.find(c => c.blockchainId === chain || c.evmChainId.toString() === chain) : null;

            // Default time range: last 30 days
            const now = Math.floor(Date.now() / 1000);
            const start = typeof startTs === 'number' ? startTs : now - 30 * 86400;
            const end = typeof endTs === 'number' ? endTs : now;

            // Collect stats from all chains
            const results: IcmGasUsageStats[] = [];

            for (const chainConfig of chains) {
                // Skip if we're filtering and this isn't the selected chain
                if (selectedChain && chainConfig.blockchainId !== selectedChain.blockchainId) {
                    continue;
                }

                try {
                    const indexerConn = dbCtx.getIndexerDbConnection(chainConfig.evmChainId, 'icm_gas_usage');

                    const query = `
                        SELECT 
                            other_chain_id,
                            SUM(send_count) as send_count,
                            SUM(receive_count) as receive_count,
                            CUSTOM_SUM_UINT256(send_gas_cost) as send_gas_cost,
                            CUSTOM_SUM_UINT256(receive_gas_cost) as receive_gas_cost
                        FROM icm_chain_interval_stats
                        WHERE interval_ts >= ? AND interval_ts <= ?
                        GROUP BY other_chain_id
                    `;

                    const stmt = indexerConn.prepare(query);
                    const rows = stmt.all(start, end) as ChainStatsResult[];

                    for (const row of rows) {
                        const otherChainConfig = dbCtx.getChainConfig(row.other_chain_id);

                        // Skip if filtering and the other chain isn't the selected chain
                        if (selectedChain && row.other_chain_id !== selectedChain.blockchainId) {
                            continue;
                        }

                        const totalCount = row.send_count + row.receive_count;

                        // Convert blobs to wei and then to ETH/AVAX
                        const sendGasWei = row.send_gas_cost ? dbFunctions.blobToUint256(row.send_gas_cost) : 0n;
                        const receiveGasWei = row.receive_gas_cost ? dbFunctions.blobToUint256(row.receive_gas_cost) : 0n;
                        const totalGasWei = sendGasWei + receiveGasWei;

                        // Convert to ETH/AVAX for API response
                        const sendGasCost = Number(sendGasWei) / 1e18;
                        const receiveGasCost = Number(receiveGasWei) / 1e18;
                        const totalGasCost = Number(totalGasWei) / 1e18;

                        if (totalCount > 0) {
                            results.push({
                                chainName: chainConfig.chainName,
                                chainBlockchainId: chainConfig.blockchainId,
                                otherChainName: otherChainConfig?.chainName || row.other_chain_id,
                                otherChainBlockchainId: row.other_chain_id,
                                sendCount: row.send_count,
                                receiveCount: row.receive_count,
                                sendGasCost,
                                receiveGasCost,
                                totalCount,
                                totalGasCost
                            });
                        }
                    }
                } catch (error) {
                    // Chain might not have the indexer, skip
                    continue;
                }
            }

            // Sort by total count (descending)
            results.sort((a, b) => b.totalCount - a.totalCount);

            return reply.send(results);
        });
    }
};

export default module;
