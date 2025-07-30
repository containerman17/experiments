import type { ApiPlugin } from "frostbyte-sdk";

type ChainIdStats = {
    chainId: number;
    txCount: number;
}

interface ChainIdRow {
    chain_id: number;
    total_tx_count: number;
}

const module: ApiPlugin = {
    name: "debug_validate_tx_chain_id_api",
    requiredIndexers: ['debug_validate_tx_chain_id'],

    registerRoutes: (app, dbCtx) => {
        app.get('/api/debug/chain-id-stats', {
            schema: {
                response: {
                    200: {
                        type: 'object',
                        additionalProperties: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    chainId: { type: 'number' },
                                    txCount: { type: 'number' }
                                },
                                required: ['chainId', 'txCount']
                            }
                        }
                    }
                }
            }
        }, async (request, reply) => {
            const configs = dbCtx.getAllChainConfigs();

            // Map to store results grouped by source chain
            const resultsByChain: Record<number, ChainIdStats[]> = {};

            // Query each chain's database
            for (const config of configs) {
                try {
                    const indexerConn = dbCtx.getIndexerDbConnection(config.evmChainId, 'debug_validate_tx_chain_id');

                    // Aggregate tx_count by chain_id for this chain
                    const stmt = indexerConn.prepare(`
                        SELECT 
                            chain_id,
                            SUM(tx_count) as total_tx_count
                        FROM debug_chain_ids
                        GROUP BY chain_id
                        ORDER BY total_tx_count DESC
                    `);
                    const results = stmt.all() as ChainIdRow[];

                    // Store results for this chain
                    if (results.length > 0) {
                        resultsByChain[config.evmChainId] = results.map(row => ({
                            chainId: row.chain_id,
                            txCount: row.total_tx_count
                        }));
                    }
                } catch (error) {
                    // Chain might not have the debug indexer
                    console.log(`Skipping chain ${config.chainName} - debug_validate_tx_chain_id indexer not found`);
                }
            }

            return reply.send(resultsByChain);
        });
    }
};

export default module;
