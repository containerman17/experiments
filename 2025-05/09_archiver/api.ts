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

export async function startAPI(indexers: Map<string, Indexer>) {
    const chainIds = Array.from(indexers.keys())
    const exampleChainId = chainIds[0]

    // API documentation on root
    fastify.get('/', async function handler(request: any, reply) {
        reply.type('text/plain')
        return `Blockchain Indexer API

Available Chains: ${chainIds.join(', ')}

Endpoints:

GET /chains
    Returns list of available chain IDs

GET /{chainId}/tx/{txHash}.json
    Get transaction details by hash
    Example: /${exampleChainId}/tx/0x123abc.json

GET /{chainId}/stats/txCount/hourly?limit=10
    Get hourly transaction counts (default limit: 10, max: 100)
    Example: /${exampleChainId}/stats/txCount/hourly?limit=24

GET /{chainId}/stats/txCount/daily?limit=10
    Get daily transaction counts (default limit: 10, max: 100)
    Example: /${exampleChainId}/stats/txCount/daily?limit=30

GET /{chainId}/stats/tps/today
    Get transactions per second for last 24 hours
    Example: /${exampleChainId}/stats/tps/today

Replace {chainId} with one of: ${chainIds.join(', ')}
`
    })

    // Route for transaction lookup by chain
    fastify.get('/:chainId/tx/:txHash.json', async function handler(request: any, reply) {
        const chainId = request.params.chainId as string
        const txHash = request.params.txHash as string

        const indexer = indexers.get(chainId)
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

    // Route for hourly tx count by chain
    fastify.get('/:chainId/stats/txCount/hourly', async function handler(request: any, reply) {
        const chainId = request.params.chainId as string

        const indexer = indexers.get(chainId)
        if (!indexer) {
            return reply.code(404).send({
                error: 'Chain not found',
                hint: `Try /${exampleChainId}/stats/txCount/hourly`
            })
        }

        const limit = Math.min(Math.max(Number(request.query.limit) || 10, 1), 100)
        return indexer.db.getHourlyTxCount(limit)
    })

    // Route for daily tx count by chain
    fastify.get('/:chainId/stats/txCount/daily', async function handler(request: any, reply) {
        const chainId = request.params.chainId as string

        const indexer = indexers.get(chainId)
        if (!indexer) {
            return reply.code(404).send({
                error: 'Chain not found',
                hint: `Try /${exampleChainId}/stats/txCount/daily`
            })
        }

        const limit = Math.min(Math.max(Number(request.query.limit) || 10, 1), 100)
        return indexer.db.getDailyTxCount(limit)
    })

    // Route for TPS over last 24 hours by chain
    fastify.get('/:chainId/stats/tps/today', async function handler(request: any, reply) {
        const chainId = request.params.chainId as string

        const indexer = indexers.get(chainId)
        if (!indexer) {
            return reply.code(404).send({
                error: 'Chain not found',
                hint: `Try /${exampleChainId}/stats/tps/today`
            })
        }

        // Get last 24 hours of hourly data
        const hourlyData = indexer.db.getHourlyTxCount(24)

        if (hourlyData.length === 0) {
            return { tps: 0, totalTxs: 0, timeSpanSeconds: 0 }
        }

        // Calculate total transactions
        const totalTxs = hourlyData.reduce((sum, hour) => sum + hour.txCount, 0)

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
        return Array.from(indexers.keys())
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

