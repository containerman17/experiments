import type { ApiPlugin } from "frostbyte-sdk";

const WELL_KNOWN_CHAINS: Record<string, string> = {
    '2LFmzhHDKxkreihEtPanVmofuFn63bsh8twnRXEbDhBtCJxURB': 'Henesys',
    '2q9e4r6Mu3U68nU1fYjgbR6JvwrRx36CohpAX5UQxse55x1Q5': 'C-Chain',
    "yH8D7ThNJkxmtkuv2jgBa4P1Rn3Qpr4pPr7QYNfcdoS6k6HWp": "C-Chain Fuji Testnet"
};

type TransferStats = {
    homeChainBlockchainId: string;
    homeChainName: string;
    remoteChainBlockchainId: string;
    remoteChainName: string;
    direction: 'in' | 'out';
    contractAddress: string;
    coinAddress: string;
    transferCount: number;
    transferCoinsTotal: number;
}

// Key for aggregating transfers: homeChain:remoteChain:direction:contractAddress:coinAddress
type TransferKey = `${string}:${string}:${string}:${string}:${string}`;

interface TokenMovementRow {
    block_timestamp: number;
    is_inbound: number;
    amount: number;
    pair_chain: string;
    contract_address: string;
    coin_address: string;
}

const module: ApiPlugin = {
    name: "ictt_homes_api",
    requiredIndexers: ["ictt"],

    registerRoutes: (app, dbCtx) => {
        app.get('/api/global/ictt/transfers', {
            schema: {
                querystring: {
                    type: 'object',
                    properties: {
                        startTs: { type: 'number' },
                        endTs: { type: 'number' }
                    }
                },
                response: {
                    200: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                homeChainBlockchainId: { type: 'string' },
                                homeChainName: { type: 'string' },
                                remoteChainBlockchainId: { type: 'string' },
                                remoteChainName: { type: 'string' },
                                direction: { type: 'string', enum: ['in', 'out'] },
                                contractAddress: { type: 'string' },
                                coinAddress: { type: 'string' },
                                transferCount: { type: 'number' },
                                transferCoinsTotal: { type: 'number' }
                            },
                            required: ['homeChainBlockchainId', 'homeChainName', 'remoteChainBlockchainId', 'remoteChainName', 'direction', 'contractAddress', 'coinAddress', 'transferCount', 'transferCoinsTotal']
                        }
                    }
                }
            }
        }, async (request, reply) => {
            const query = request.query as { startTs?: number; endTs?: number };

            // No default limits - if not set, query all data
            const startTs = query.startTs || 0;
            const endTs = query.endTs || Number.MAX_SAFE_INTEGER;

            const configs = dbCtx.getAllChainConfigs();

            // Helper to get chainName by blockchainId
            const chainNameById = new Map<string, string>();
            for (const config of configs) {
                chainNameById.set(config.blockchainId, config.chainName);
            }

            // Map to store aggregated transfer stats
            const transferStats = new Map<TransferKey, TransferStats>();

            // Query each chain's database
            for (const config of configs) {
                try {
                    const indexerConn = dbCtx.getIndexerDbConnection(config.evmChainId, "ictt_homes");

                    // Query token movements joined with recognized homes to get coin address
                    // Only include contracts that have at least one remote registered
                    const stmt = indexerConn.prepare(`
                        SELECT 
                            tm.block_timestamp,
                            tm.is_inbound,
                            tm.amount,
                            tm.pair_chain,
                            tm.contract_address,
                            rth.coin_address
                        FROM token_movements tm
                        JOIN recognized_token_homes rth ON tm.contract_address = rth.contract_address
                        WHERE tm.block_timestamp >= ? AND tm.block_timestamp <= ?
                          AND rth.at_least_one_remote_registered = 1
                    `);
                    const results = stmt.all(startTs, endTs) as TokenMovementRow[];

                    // Process each row - the current chain is always the home chain
                    for (const row of results) {
                        const homeChainId = config.blockchainId;
                        const remoteChainId = row.pair_chain;
                        const direction: 'in' | 'out' = row.is_inbound === 1 ? 'in' : 'out';

                        // Create unique key for this specific transfer pattern
                        const key: TransferKey = `${homeChainId}:${remoteChainId}:${direction}:${row.contract_address}:${row.coin_address}`;

                        const existing = transferStats.get(key);
                        if (existing) {
                            existing.transferCount++;
                            existing.transferCoinsTotal += row.amount;
                        } else {
                            const homeName = chainNameById.get(homeChainId) || WELL_KNOWN_CHAINS[homeChainId] || homeChainId;
                            const remoteName = chainNameById.get(remoteChainId) || WELL_KNOWN_CHAINS[remoteChainId] || remoteChainId;

                            transferStats.set(key, {
                                homeChainBlockchainId: homeChainId,
                                homeChainName: homeName,
                                remoteChainBlockchainId: remoteChainId,
                                remoteChainName: remoteName,
                                direction: direction,
                                contractAddress: row.contract_address,
                                coinAddress: row.coin_address,
                                transferCount: 1,
                                transferCoinsTotal: row.amount
                            });
                        }
                    }
                } catch (error) {
                    // Chain might not have the ictt_homes indexer
                    console.log(`Skipping chain ${config.chainName} - ictt_homes indexer not found`);
                }
            }

            // Convert map values to array
            const results: TransferStats[] = Array.from(transferStats.values());

            // Sort by transferCount descending
            results.sort((a, b) => b.transferCount - a.transferCount);

            return reply.send(results);
        });

        // New endpoint for individual transfers list
        app.get('/api/global/ictt/transfers-list', {
            schema: {
                querystring: {
                    type: 'object',
                    properties: {
                        startTs: { type: 'number' },
                        endTs: { type: 'number' },
                        homeChain: { type: 'string' },
                        remoteChain: { type: 'string' },
                        contractAddress: { type: 'string' },
                        coinAddress: { type: 'string' }
                    }
                },
                response: {
                    200: {
                        type: 'object',
                        properties: {
                            transfers: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        homeChainBlockchainId: { type: 'string' },
                                        homeChainName: { type: 'string' },
                                        remoteChainBlockchainId: { type: 'string' },
                                        remoteChainName: { type: 'string' },
                                        direction: { type: 'string', enum: ['in', 'out'] },
                                        contractAddress: { type: 'string' },
                                        coinAddress: { type: 'string' },
                                        amount: { type: 'number' },
                                        blockTimestamp: { type: 'number' }
                                    },
                                    required: ['homeChainBlockchainId', 'homeChainName', 'remoteChainBlockchainId', 'remoteChainName', 'direction', 'contractAddress', 'coinAddress', 'amount', 'blockTimestamp']
                                }
                            },
                            totalCount: { type: 'number' },
                            availableChains: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        blockchainId: { type: 'string' },
                                        chainName: { type: 'string' }
                                    },
                                    required: ['blockchainId', 'chainName']
                                }
                            }
                        },
                        required: ['transfers', 'totalCount', 'availableChains']
                    }
                }
            }
        }, async (request, reply) => {
            const query = request.query as {
                startTs?: number;
                endTs?: number;
                homeChain?: string;
                remoteChain?: string;
                contractAddress?: string;
                coinAddress?: string;
            };

            const startTs = query.startTs || 0;
            const endTs = query.endTs || Math.floor(Date.now() / 1000);

            const configs = dbCtx.getAllChainConfigs();

            // Helper to get chainName by blockchainId
            const chainNameById = new Map<string, string>();
            const availableChains: Array<{ blockchainId: string, chainName: string }> = [];
            for (const config of configs) {
                chainNameById.set(config.blockchainId, config.chainName);
                availableChains.push({
                    blockchainId: config.blockchainId,
                    chainName: config.chainName
                });
            }

            // Also add well-known chains
            for (const [blockchainId, chainName] of Object.entries(WELL_KNOWN_CHAINS)) {
                if (!chainNameById.has(blockchainId)) {
                    chainNameById.set(blockchainId, chainName);
                    availableChains.push({ blockchainId, chainName });
                }
            }

            interface TransferRecord {
                homeChainBlockchainId: string;
                homeChainName: string;
                remoteChainBlockchainId: string;
                remoteChainName: string;
                direction: 'in' | 'out';
                contractAddress: string;
                coinAddress: string;
                amount: number;
                blockTimestamp: number;
            }

            const allTransfers: TransferRecord[] = [];

            // Query each chain's database
            for (const config of configs) {
                // Skip if filtering by home chain and this isn't it
                if (query.homeChain && config.blockchainId !== query.homeChain) {
                    continue;
                }

                try {
                    const indexerConn = dbCtx.getIndexerDbConnection(config.evmChainId, "ictt_homes");

                    // Build SQL query with filters
                    let sql = `
                        SELECT 
                            tm.block_timestamp,
                            tm.is_inbound,
                            tm.amount,
                            tm.pair_chain,
                            tm.contract_address,
                            rth.coin_address
                        FROM token_movements tm
                        JOIN recognized_token_homes rth ON tm.contract_address = rth.contract_address
                        WHERE tm.block_timestamp >= ? AND tm.block_timestamp <= ?
                          AND rth.at_least_one_remote_registered = 1
                    `;

                    const params: any[] = [startTs, endTs];

                    if (query.remoteChain) {
                        sql += ' AND tm.pair_chain = ?';
                        params.push(query.remoteChain);
                    }

                    if (query.contractAddress) {
                        sql += ' AND tm.contract_address = ?';
                        params.push(query.contractAddress);
                    }

                    if (query.coinAddress) {
                        sql += ' AND rth.coin_address = ?';
                        params.push(query.coinAddress);
                    }

                    sql += ' ORDER BY tm.block_timestamp DESC';

                    const stmt = indexerConn.prepare(sql);
                    const results = stmt.all(...params) as TokenMovementRow[];

                    // Process each row
                    for (const row of results) {
                        const homeChainId = config.blockchainId;
                        const remoteChainId = row.pair_chain;
                        const direction: 'in' | 'out' = row.is_inbound === 1 ? 'in' : 'out';

                        const homeName = chainNameById.get(homeChainId) || WELL_KNOWN_CHAINS[homeChainId] || homeChainId;
                        const remoteName = chainNameById.get(remoteChainId) || WELL_KNOWN_CHAINS[remoteChainId] || remoteChainId;

                        allTransfers.push({
                            homeChainBlockchainId: homeChainId,
                            homeChainName: homeName,
                            remoteChainBlockchainId: remoteChainId,
                            remoteChainName: remoteName,
                            direction: direction,
                            contractAddress: row.contract_address,
                            coinAddress: row.coin_address,
                            amount: row.amount,
                            blockTimestamp: row.block_timestamp
                        });
                    }
                } catch (error) {
                    console.log(`Skipping chain ${config.chainName} - ictt_homes indexer not found`);
                }
            }

            // Sort by timestamp descending
            allTransfers.sort((a, b) => b.blockTimestamp - a.blockTimestamp);

            // Return first 100 transfers and total count
            const limitedTransfers = allTransfers.slice(0, 100);

            return reply.send({
                transfers: limitedTransfers,
                totalCount: allTransfers.length,
                availableChains: availableChains
            });
        });
    }
};

export default module;
