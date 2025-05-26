// Import the framework and instantiate it
import Fastify from 'fastify'
import type { IndexerAPI } from './indexerAPI'
import type { Hex } from 'viem'
import { isHex } from 'viem'

let started = false
export async function startAPI(indexer: IndexerAPI) {
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

        console.log('🔍 txHash', txHash)
        const tx = await indexer.getTx(txHash as Hex)

        if (!tx) {
            return reply.code(404).send({ error: 'Transaction not found' })
        }

        return tx
    })

    await fastify.listen({ port: 3000 })
}
