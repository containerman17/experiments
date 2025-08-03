import type { ApiPlugin } from "frostbyte-sdk";

const WELL_KNOWN_CHAINS: Record<string, string> = {
    '2LFmzhHDKxkreihEtPanVmofuFn63bsh8twnRXEbDhBtCJxURB': 'Henesys',
    '2q9e4r6Mu3U68nU1fYjgbR6JvwrRx36CohpAX5UQxse55x1Q5': 'C-Chain',
};

type TransferStats = {
    homeChainBlockchainId: string;
    homeChainName: string;
    remoteChainBlockchainId: string;
    remoteChainName: string;
    direction: 'in' | 'out';
    coinAddress: string;
    transferCount: number;
    transferCoinsTotal: number;
}

// Key for aggregating transfers: homeChain:remoteChain:direction:coinAddress
type TransferKey = `${string}:${string}:${string}:${string}`;

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
    requiredIndexers: ["ictt_homes"],

    registerRoutes: (app, dbCtx) => {
        app.get('/api/ictt/transfers', {
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
                                coinAddress: { type: 'string' },
                                transferCount: { type: 'number' },
                                transferCoinsTotal: { type: 'number' }
                            },
                            required: ['homeChainBlockchainId', 'homeChainName', 'remoteChainBlockchainId', 'remoteChainName', 'direction', 'coinAddress', 'transferCount', 'transferCoinsTotal']
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
                    `);
                    const results = stmt.all(startTs, endTs) as TokenMovementRow[];

                    // Process each row - the current chain is always the home chain
                    for (const row of results) {
                        const homeChainId = config.blockchainId;
                        const remoteChainId = row.pair_chain;
                        const direction: 'in' | 'out' = row.is_inbound === 1 ? 'in' : 'out';

                        // Create unique key for this specific transfer pattern
                        const key: TransferKey = `${homeChainId}:${remoteChainId}:${direction}:${row.coin_address}`;

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
    }
};

export default module;
