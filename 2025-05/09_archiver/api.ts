// Import the framework and instantiate it
import Fastify from 'fastify'
import type { IndexerAPI } from './indexerAPI'
import type { Hex, Transaction, TransactionReceipt } from 'viem'
import { isHex } from 'viem'
import type { BatchRpc } from './rpc/rpc'
import type { Database } from './database/db'
import type { Indexer } from './indexer'

const fastify = Fastify({
    logger: true
})

export async function startAPI(indexers: Map<string, Indexer>, aliases: Map<string, string>) {
    const chainIds = Array.from(indexers.keys())
    const exampleChainId = chainIds[0]

    // Helper function to resolve chain ID through aliases
    function getIndexer(chainId: string): Indexer | undefined {
        // Try direct lookup first
        let indexer = indexers.get(chainId);
        if (indexer) return indexer;

        // Try alias lookup
        const primaryChainId = aliases.get(chainId);
        if (primaryChainId) {
            return indexers.get(primaryChainId);
        }

        return undefined;
    }

    // Helper function to build chain info objects
    function getChainInfo() {
        const chains = [];
        for (const [avalancheChainId, indexer] of indexers) {
            // Find the EVM chain ID by looking through aliases
            let evmChainId = null;
            for (const [alias, primaryId] of aliases) {
                if (primaryId === avalancheChainId && !alias.startsWith('0x')) {
                    evmChainId = parseInt(alias);
                    break;
                }
            }

            chains.push({
                avalancheChainId,
                evmChainId,
                evmChainIdHex: evmChainId ? `0x${evmChainId.toString(16)}` : null
            });
        }
        return chains;
    }

    // API documentation on root
    fastify.get('/', async function handler(request: any, reply) {
        reply.type('text/plain')

        const chainInfo = getChainInfo()
        const chainList = chainInfo.map(chain =>
            `${chain.avalancheChainId} (EVM: ${chain.evmChainId}, ${chain.evmChainIdHex})`
        ).join(', ')

        return `Blockchain Indexer API

Available Chains: ${chainList}

Note: You can use any of the chain ID formats (Avalanche chain ID, EVM chain ID decimal, or EVM chain ID hex) in the endpoints below.

Endpoints:

GET /chains
    Returns list of available chain IDs

GET /indexing
    Returns indexing status for all chains (block number, timestamp, days ago)

GET /{chainId}/tx/{txHash}.json
    Get transaction details by hash
    Example: /${exampleChainId}/tx/0x123abc.json

GET /{chainId}/stats/txCount/{interval}?limit=10
    Get transaction counts by time interval (default limit: 10, max: 100)
    Intervals: "1h" or "1d"
    Examples: 
        /${exampleChainId}/stats/txCount/1h?limit=24
        /${exampleChainId}/stats/txCount/1d?limit=30

GET /{chainId}/stats/tps/today
    Get transactions per second for last 24 hours
    Example: /${exampleChainId}/stats/tps/today

Replace {chainId} with any supported format from the chains listed above.
`
    })

    // Route for transaction lookup by chain
    fastify.get('/:chainId/tx/:txHash.json', async function handler(request: any, reply) {
        const chainId = request.params.chainId as string
        const txHash = request.params.txHash as string

        const indexer = getIndexer(chainId)
        if (!indexer) {
            return reply.code(404).send({
                error: 'Chain not found',
                hint: `Try /${exampleChainId}/tx/0x123.json`
            })
        }

        if (!isHex(txHash)) {
            return reply.code(400).send({ error: 'Invalid transaction hash format' })
        }

        const blocks = indexer.db.getTxLookupByPrefix(txHash as Hex)
        const txs = await fetchTxsFromBlocks([txHash], blocks, indexer.rpc)
        if (txs.length === 0) {
            return reply.code(404).send({ error: 'Transaction not found' })
        }
        return txs[0]
    })

    // Route for tx count by time interval
    fastify.get('/:chainId/stats/txCount/:interval', async function handler(request: any, reply) {
        const chainId = request.params.chainId as string
        const interval = request.params.interval as string

        const indexer = getIndexer(chainId)
        if (!indexer) {
            return reply.code(404).send({
                error: 'Chain not found',
                hint: `Try /${exampleChainId}/stats/txCount/1h`
            })
        }

        if (interval !== '1h' && interval !== '1d') {
            return reply.code(400).send({
                error: 'Invalid interval',
                hint: 'Use "1h" or "1d"'
            })
        }

        const limit = Math.min(Math.max(Number(request.query.limit) || 10, 1), 100)
        return indexer.db.getTxCount(interval, limit)
    })

    // Route for TPS over last 24 hours by chain
    fastify.get('/:chainId/stats/tps/today', async function handler(request: any, reply) {
        const chainId = request.params.chainId as string

        const indexer = getIndexer(chainId)
        if (!indexer) {
            return reply.code(404).send({
                error: 'Chain not found',
                hint: `Try /${exampleChainId}/stats/tps/today`
            })
        }

        // Get last 24 hours of hourly data
        const hourlyData = indexer.db.getTxCount('1h', 24)

        if (hourlyData.length === 0) {
            return { tps: 0, totalTxs: 0, timeSpanSeconds: 0 }
        }

        // Calculate total transactions
        const totalTxs = hourlyData.reduce((sum, hour) => sum + hour.value, 0)

        // Calculate exact time span
        const now = Date.now()
        const currentHourStart = Math.floor(now / (1000 * 60 * 60)) * (1000 * 60 * 60)
        const secondsIntoCurrentHour = Math.floor((now - currentHourStart) / 1000)
        const timeSpanSeconds = (24 * 60 * 60) - (60 * 60 - secondsIntoCurrentHour)

        const tps = totalTxs / timeSpanSeconds

        return {
            tps: Number(tps.toFixed(6)),
            totalTxs,
            timeSpanSeconds,
        }
    })

    // List available chains
    fastify.get('/chains', async function handler(request: any, reply) {
        return getChainInfo()
    })

    // Indexing status for all chains
    fastify.get('/indexing', async function handler(request: any, reply) {
        const indexingPromises = Array.from(indexers.entries()).map(async ([avalancheChainId, indexer]) => {
            const lastProcessedBlockNumber = indexer.db.getLastProcessedBlockNumber();

            if (lastProcessedBlockNumber === -1) {
                return {
                    avalancheChainId,
                    evmChainId: null,
                    blockNumber: -1,
                    blockTime: null,
                    daysAgo: null
                };
            }

            try {
                const blocks = await indexer.rpc.getBlocksWithReceipts([lastProcessedBlockNumber]);

                if (blocks.length === 0) {
                    return {
                        avalancheChainId,
                        evmChainId: null,
                        blockNumber: lastProcessedBlockNumber,
                        blockTime: null,
                        daysAgo: null
                    };
                }

                const block = blocks[0]!;
                const blockTimestamp = Number(block.block.timestamp);
                const now = Math.floor(Date.now() / 1000);
                const secondsAgo = now - blockTimestamp;
                const daysAgo = Number((secondsAgo / (24 * 60 * 60)).toFixed(2));

                // Find the EVM chain ID by looking through aliases
                const evmChainId = Array.from(aliases.entries())
                    .find(([alias, primaryId]) => primaryId === avalancheChainId && !alias.startsWith('0x'))?.[0]
                    ? parseInt(Array.from(aliases.entries())
                        .find(([alias, primaryId]) => primaryId === avalancheChainId && !alias.startsWith('0x'))![0])
                    : null;

                return {
                    avalancheChainId,
                    evmChainId,
                    blockNumber: lastProcessedBlockNumber,
                    blockTime: blockTimestamp,
                    daysAgo
                };

            } catch (error) {
                console.error(`Error fetching block ${lastProcessedBlockNumber} for chain ${avalancheChainId}:`, error);
                return {
                    avalancheChainId,
                    evmChainId: null,
                    blockNumber: lastProcessedBlockNumber,
                    blockTime: null,
                    daysAgo: null
                };
            }
        });

        return Promise.all(indexingPromises);
    })

    // Catch-all for unhandled routes
    fastify.setNotFoundHandler(async function handler(request, reply) {
        return reply.code(404).send({
            error: 'Route not found',
            hint: `Try /${exampleChainId}/stats/txCount/hourly or /chains or / for docs`
        })
    })

    await fastify.listen({ port: 3000 })
}

async function fetchTxsFromBlocks(txHashes: Hex[], blockNumbers: number[], rpc: BatchRpc): Promise<{ transaction: Transaction; receipt: TransactionReceipt; blockNumber: bigint }[]> {
    const fetchedBlocksData = await rpc.getBlocksWithReceipts(blockNumbers);
    const foundTxs = new Set<Hex>();
    const txs: { transaction: Transaction; receipt: TransactionReceipt; blockNumber: bigint }[] = [];

    for (const block of fetchedBlocksData) {
        for (const tx of block.block.transactions) {
            if (txHashes.includes(tx.hash)) {
                txs.push({
                    transaction: tx,
                    receipt: block.receipts[tx.hash],
                    blockNumber: block.block.number
                });
                foundTxs.add(tx.hash);
                if (foundTxs.size === txHashes.length) {
                    return txs;
                }
            }
        }
    }

    if (foundTxs.size !== txHashes.length) {
        const missing = txHashes.filter(hash => !foundTxs.has(hash));
        throw new Error(`Transactions not found: ${missing.join(', ')}`);
    }

    return txs;
}

