/**
 * Contract Stats API Plugin
 * 
 * This API provides comprehensive statistics for specified contract addresses on a given chain.
 * It aggregates data from multiple indexers to provide a complete picture of contract activity.
 * 
 * Endpoint: /api/:evmChainId/contract-stats
 * 
 * Query Parameters:
 * - contracts: Comma-separated list of contract addresses (required)
 * - tsFrom: Start timestamp in seconds (default: 0)
 * - tsTo: End timestamp in seconds (default: current time)
 * 
 * Returns statistics including:
 * - Total transactions to these contracts
 * - Total AVAX cost burned (gas × gas price)
 * - ICM messages emitted count and gas cost
 * - Unique and average daily interacting addresses
 * - Transaction concentration (top 5 and top 20 accounts)
 */

import type { ApiPlugin } from "frostbyte-sdk";
import { dbFunctions } from "frostbyte-sdk";

interface ContractStatsResponse {
    contracts: string[];
    timeRange: {
        from: number;
        to: number;
    };
    transactions: {
        total: number;
        totalGasCost: number; // in native tokens (ETH/AVAX)
    };
    icmMessages: {
        count: number;
        totalGasCost: number; // in native tokens (ETH/AVAX)
    };
    interactions: {
        uniqueAddresses: number;
        avgDailyAddresses: number;
    };
    concentration: {
        top5AccountsPercentage: number;
        top20AccountsPercentage: number;
    };
}

interface GasBurnedResult {
    tx_count: number;
    total_avax_cost: Buffer | null;
}

interface IcmEmitterResult {
    message_count: number;
    total_gas_cost: Buffer | null;
}

interface InteractionResult {
    from_address: string;
    tx_count: number;
}


const module: ApiPlugin = {
    name: "contract_stats_api",
    requiredIndexers: ['gas_burned_by_address', 'icm_messages_by_contract', 'daily_interactions'],
    version: 2,

    registerRoutes: (app, dbCtx) => {
        app.get<{
            Params: { evmChainId: string };
            Querystring: {
                contracts: string;
                tsFrom?: number;
                tsTo?: number;
            }
        }>('/api/:evmChainId/contract-stats', {
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
                        contracts: {
                            type: 'string',
                            description: 'Comma-separated list of contract addresses'
                        },
                        tsFrom: {
                            type: 'number',
                            minimum: 0,
                            description: 'Start timestamp in seconds (default: 0)'
                        },
                        tsTo: {
                            type: 'number',
                            minimum: 0,
                            description: 'End timestamp in seconds (default: now)'
                        }
                    },
                    required: ['contracts']
                },
                response: {
                    200: {
                        type: 'object',
                        properties: {
                            contracts: {
                                type: 'array',
                                items: { type: 'string' }
                            },
                            timeRange: {
                                type: 'object',
                                properties: {
                                    from: { type: 'number' },
                                    to: { type: 'number' }
                                },
                                required: ['from', 'to']
                            },
                            transactions: {
                                type: 'object',
                                properties: {
                                    total: { type: 'number' },
                                    totalGasCost: { type: 'number' }
                                },
                                required: ['total', 'totalGasCost']
                            },
                            icmMessages: {
                                type: 'object',
                                properties: {
                                    count: { type: 'number' },
                                    totalGasCost: { type: 'number' }
                                },
                                required: ['count', 'totalGasCost']
                            },
                            interactions: {
                                type: 'object',
                                properties: {
                                    uniqueAddresses: { type: 'number' },
                                    avgDailyAddresses: { type: 'number' }
                                },
                                required: ['uniqueAddresses', 'avgDailyAddresses']
                            },
                            concentration: {
                                type: 'object',
                                properties: {
                                    top5AccountsPercentage: { type: 'number' },
                                    top20AccountsPercentage: { type: 'number' }
                                },
                                required: ['top5AccountsPercentage', 'top20AccountsPercentage']
                            }
                        },
                        required: ['contracts', 'timeRange', 'transactions', 'icmMessages', 'interactions', 'concentration']
                    },
                    404: {
                        type: 'object',
                        properties: {
                            error: { type: 'string' }
                        }
                    }
                }
            }
        }, async (request, reply) => {
            const evmChainId = parseInt(request.params.evmChainId);
            const { contracts: contractsParam, tsFrom, tsTo } = request.query;

            // Validate chain exists
            const chainConfig = dbCtx.getAllChainConfigs().find(c => c.evmChainId === evmChainId);
            if (!chainConfig) {
                return reply.code(404).send({ error: `Chain ${evmChainId} not found` });
            }

            // Parse and normalize contract addresses
            const contracts = contractsParam.split(',').map(addr => addr.trim()).map(addr => addr.toLowerCase());

            // Set time range
            const now = Math.floor(Date.now() / 1000);
            const startTs = tsFrom !== undefined ? tsFrom : (now - 30 * 86400); // Default to 1 month ago
            const endTs = tsTo || now;

            // Get database connections
            const gasBurnedConn = dbCtx.getIndexerDbConnection(evmChainId, 'gas_burned_by_address');
            const icmConn = dbCtx.getIndexerDbConnection(evmChainId, 'icm_messages_by_contract');
            const interactionsConn = dbCtx.getIndexerDbConnection(evmChainId, 'daily_interactions');

            // Build placeholders for SQL IN clause
            const placeholders = contracts.map(() => '?').join(',');

            // 1. Get total transactions and AVAX cost from gas_burned_by_address
            const gasBurnedQuery = `
                SELECT 
                    SUM(tx_count) as tx_count,
                    CUSTOM_SUM_UINT256(total_avax_cost) as total_avax_cost
                FROM gas_burned_by_receiver
                WHERE address IN (${placeholders})
                AND timestamp >= ? AND timestamp <= ?
            `;
            const gasBurnedStmt = gasBurnedConn.prepare(gasBurnedQuery);
            const gasBurnedResult = gasBurnedStmt.get(...contracts, startTs, endTs) as GasBurnedResult;

            const totalTxs = gasBurnedResult?.tx_count || 0;
            const totalAvaxWei = gasBurnedResult?.total_avax_cost
                ? dbFunctions.blobToUint256(gasBurnedResult.total_avax_cost)
                : 0n;
            const totalGasCost = Number(totalAvaxWei) / 1e18;

            // 2. Get ICM messages stats from icm_messages_by_contract
            const icmQuery = `
                SELECT 
                    SUM(message_count) as message_count,
                    CUSTOM_SUM_UINT256(total_gas_cost) as total_gas_cost
                FROM icm_messages_by_contract
                WHERE contract IN (${placeholders})
                AND timestamp >= ? AND timestamp <= ?
            `;
            const icmStmt = icmConn.prepare(icmQuery);
            const icmResult = icmStmt.get(...contracts, startTs, endTs) as IcmEmitterResult;

            const icmMessageCount = icmResult?.message_count || 0;
            const icmGasWei = icmResult?.total_gas_cost
                ? dbFunctions.blobToUint256(icmResult.total_gas_cost)
                : 0n;
            const icmTotalGasCost = Number(icmGasWei) / 1e18;

            // 3. Get unique addresses and daily average from daily_interactions
            const uniqueAddressesQuery = `
                SELECT DISTINCT from_address
                FROM daily_interactions
                WHERE to_address IN (${placeholders})
                AND timestamp >= ? AND timestamp <= ?
            `;
            const uniqueAddressesStmt = interactionsConn.prepare(uniqueAddressesQuery);
            const uniqueAddresses = uniqueAddressesStmt.all(...contracts, startTs, endTs) as { from_address: string }[];
            const uniqueAddressCount = uniqueAddresses.length;

            // Calculate average daily addresses over the entire time range
            const totalDays = Math.max(1, Math.ceil((endTs - startTs) / 86400));
            const avgDailyAddresses = Math.round(uniqueAddressCount / totalDays);

            // 4. Calculate concentration metrics (top 5 and top 20 accounts)
            const txByAddressQuery = `
                SELECT from_address, SUM(tx_count) as tx_count
                FROM daily_interactions
                WHERE to_address IN (${placeholders})
                AND timestamp >= ? AND timestamp <= ?
                GROUP BY from_address
                ORDER BY tx_count DESC
            `;
            const txByAddressStmt = interactionsConn.prepare(txByAddressQuery);
            const txByAddress = txByAddressStmt.all(...contracts, startTs, endTs) as InteractionResult[];

            let top5Txs = 0;
            let top20Txs = 0;
            let totalInteractionTxs = 0;

            txByAddress.forEach((row, index) => {
                totalInteractionTxs += row.tx_count;
                if (index < 5) {
                    top5Txs += row.tx_count;
                }
                if (index < 20) {
                    top20Txs += row.tx_count;
                }
            });

            const top5Percentage = totalInteractionTxs > 0
                ? Number(((top5Txs / totalInteractionTxs) * 100).toFixed(2))
                : 0;
            const top20Percentage = totalInteractionTxs > 0
                ? Number(((top20Txs / totalInteractionTxs) * 100).toFixed(2))
                : 0;

            // Build response
            const response: ContractStatsResponse = {
                contracts,
                timeRange: {
                    from: startTs,
                    to: endTs
                },
                transactions: {
                    total: totalTxs,
                    totalGasCost
                },
                icmMessages: {
                    count: icmMessageCount,
                    totalGasCost: icmTotalGasCost
                },
                interactions: {
                    uniqueAddresses: uniqueAddressCount,
                    avgDailyAddresses
                },
                concentration: {
                    top5AccountsPercentage: top5Percentage,
                    top20AccountsPercentage: top20Percentage
                }
            };

            return reply.send(response);
        });
    }
};

export default module;
