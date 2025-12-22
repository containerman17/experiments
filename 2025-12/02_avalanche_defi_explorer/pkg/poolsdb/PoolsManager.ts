import * as lmdb from 'lmdb'
import { CachedRpcClient } from '../CachedRpcClient.ts'
import { type CachedRPC, type PoolProvider, type PoolType } from '../providers/_types.ts'
import { createPublicClient, http, webSocket } from 'viem'
import { avalanche } from 'viem/chains'
import { type Log } from 'viem'
import { PoolsDB } from './PoolsDB.ts'

// const BLOCKS_BEHIND_LOOKUP = (10 * 24 * 60 * 60 * 1000) / 1250 //10 days with 1250ms block time
const BLOCKS_BEHIND_LOOKUP = (6 * 60 * 60 * 1000) / 1250 //6 hours is fine

const createPublicClientUniversal = (rpcUrl: string) => {
    return createPublicClient({
        chain: avalanche,
        transport: rpcUrl.startsWith("http") ? http(rpcUrl) : webSocket(rpcUrl),
    })
}

export type addPoolCallback = (pool: string, tokenIn: string, tokenOut: string, poolType: PoolType, providerName: string) => void

export class PoolsManager {
    private providers: PoolProvider[]
    private cachedRPC: CachedRPC//only for processLogs, do not use in fetching logs 
    private catchUpRPC: ReturnType<typeof createPublicClientUniversal>
    private logsDb: lmdb.Database
    private lastCatchUpReport = 0
    private poolsDB: PoolsDB

    constructor(_providers: PoolProvider[], rpcUrl: string, rootDb: lmdb.RootDatabase, poolsDB: PoolsDB) {
        this.providers = _providers
        this.cachedRPC = new CachedRpcClient(rpcUrl, rootDb.openDB({
            name: 'cached_rpc',
            compression: true
        }))
        this.catchUpRPC = createPublicClientUniversal(rpcUrl)
        this.logsDb = rootDb.openDB({
            name: 'logs_db',
            compression: true
        })
        this.poolsDB = poolsDB
    }

    public static get batchSize(): number {
        return 100
    }

    async catchUp(blockNumber: number, bustWatermark: boolean = false) {
        if (blockNumber % PoolsManager.batchSize !== 0) {
            throw "blockNumber must be a multiple of batchSize"
        }

        // Get last synced watermark from database
        const watermarkKey = 'last_synced_block'
        let lastSynced = this.logsDb.get(watermarkKey) as number | undefined
        if (bustWatermark) {
            lastSynced = undefined
        }

        // If no watermark exists, start from BLOCKS_BEHIND_LOOKUP rounded up to nearest batchSize
        if (lastSynced === undefined) {
            lastSynced = Math.ceil((blockNumber - BLOCKS_BEHIND_LOOKUP) / PoolsManager.batchSize) * PoolsManager.batchSize
        }

        const totalBatches = Math.ceil((blockNumber - lastSynced) / PoolsManager.batchSize)
        let batchNumber = 0
        const startTime = Date.now()

        // Fetch/Process blocks in batches
        for (let fromBlock = lastSynced; fromBlock < blockNumber; fromBlock += PoolsManager.batchSize) {
            batchNumber++
            const toBlock = Math.min(fromBlock + PoolsManager.batchSize - 1, blockNumber - 1)
            const blockRangeKey = `logs_${fromBlock}_${toBlock}`

            let logs = this.logsDb.get(blockRangeKey) as Log[] | undefined

            if (!logs) {
                console.time(`Fetching logs from block ${fromBlock} to ${toBlock}`)
                logs = await this.catchUpRPC.getLogs({
                    fromBlock: BigInt(fromBlock),
                    toBlock: BigInt(toBlock),
                })
                console.timeEnd(`Fetching logs from block ${fromBlock} to ${toBlock}`)

                // Store logs in database with block range as key
                this.logsDb.put(blockRangeKey, logs)

                // Update watermark
                this.logsDb.put(watermarkKey, toBlock + 1)
            }

            await Promise.all(this.providers.map(async (provider) => {
                const swapEvents = await provider.processLogs(logs, this.cachedRPC)
                for (const event of swapEvents) {
                    this.poolsDB.addPool(event.pool, event.tokenIn, event.tokenOut, event.poolType, event.providerName)
                }
            }))

            // Calculate progress and ETA
            const batchesRemaining = totalBatches - batchNumber
            const avgTimePerBatch = (Date.now() - startTime) / batchNumber
            const etaMs = avgTimePerBatch * batchesRemaining
            const etaMinutes = Math.floor(etaMs / 60000)
            const etaSeconds = Math.floor((etaMs % 60000) / 1000)

            if (Date.now() - this.lastCatchUpReport > 1000) {
                this.lastCatchUpReport = Date.now()
                console.log(`Processed logs from block ${fromBlock} to ${toBlock} | Batch ${batchNumber}/${totalBatches} | ${batchesRemaining} remaining | ETA: ${etaMinutes}m ${etaSeconds}s`)
            }
        }

        console.log(`Catch up complete. Synced up to block ${blockNumber}`)
    }

    async processLiveLogs(logs: Log[]) {
        await Promise.all(this.providers.map(async (provider) => {
            const swapEvents = await provider.processLogs(logs, this.cachedRPC)
            for (const event of swapEvents) {
                this.poolsDB.addPool(event.pool, event.tokenIn, event.tokenOut, event.poolType, event.providerName)
            }
        }))
    }
}