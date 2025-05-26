// Import the framework and instantiate it
import Fastify from 'fastify'
import type { IndexerAPI } from './indexerAPI'
import type { Hex, Transaction, TransactionReceipt } from 'viem'
import { isHex } from 'viem'
import type { BatchRpc } from './rpc/rpc'
import type { Database } from './database/db'

let started = false
export async function startAPI(rpc: BatchRpc, db: Database) {
    if (started) throw new Error('API already started')
    started = true

    const fastify = Fastify({
        logger: true
    })


    fastify.get('/tx/:txHash.json', async function handler(request: any, reply) {
        const txHash = request.params.txHash as string

        if (!isHex(txHash)) {
            return reply.code(400).send({ error: 'Invalid transaction hash format' })
        }

        const blocks = db.getTxLookupByPrefix(txHash as Hex)
        const txs = await fetchTxsFromBlocks([txHash], blocks, rpc)
        if (txs.length === 0) {
            return reply.code(404).send({ error: 'Transaction not found' })
        }
        return txs[0]
    })
    fastify.get('/stats/txCount/hourly', async function handler(request: any, reply) {
        const limit = Math.min(Math.max(Number(request.query.limit) || 10, 1), 100)
        return db.getHourlyTxCount(limit)
    })

    fastify.get('/stats/txCount/daily', async function handler(request: any, reply) {
        const limit = Math.min(Math.max(Number(request.query.limit) || 10, 1), 100)
        return db.getDailyTxCount(limit)
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

