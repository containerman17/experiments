import { getCachedRpcClient } from '../../pkg/CachedRpcClient.ts'
import { providers } from '../../pkg/providers/index.ts'
import { createPublicClient, http, webSocket } from 'viem'
import { avalanche } from 'viem/chains'
import { type Log } from 'viem'
import { savePools, loadPools } from '../../pkg/poolsdb/PoolLoader.ts'
import { getRpcUrl } from '../../pkg/rpc.ts'
import * as lmdb from 'lmdb'
import * as path from 'path'

const BLOCKS_BEHIND_LOOKUP = (24 * 60 * 60 * 1000) / 1250
const BATCH_SIZE = 100
const RPC_URL = getRpcUrl()
const OUTPUT_FILE = './experiments/01_discover_pools/pools.txt'

const createPublicClientUniversal = (rpcUrl: string) => {
    return createPublicClient({
        chain: avalanche,
        transport: rpcUrl.startsWith("http") ? http(rpcUrl) : webSocket(rpcUrl),
    })
}

const discoveredPoolsDb = lmdb.open({
    path: path.join(import.meta.dirname, "./data/pools_db_cache"),
    compression: true
})

type DiscoveredPool = {
    address: string
    providerName: string
    poolType: number
    tokens: Set<string>
}

console.log('Starting pool discovery...')

const cachedRPC = getCachedRpcClient(RPC_URL)

const catchUpRPC = createPublicClientUniversal(RPC_URL)

// Get current block number
const currentBlock = Number(await catchUpRPC.getBlockNumber())
console.log(`Current block: ${currentBlock}`)

// Calculate start block based on lookup window
const fromBlockBase = Math.floor((currentBlock - BLOCKS_BEHIND_LOOKUP) / BATCH_SIZE) * BATCH_SIZE
console.log(`Scanning from block ${fromBlockBase} to current...`)

const roundedBlock = Math.floor(currentBlock / BATCH_SIZE) * BATCH_SIZE
const totalBatches = Math.ceil((roundedBlock - fromBlockBase) / BATCH_SIZE)
let batchNumber = 0
const startTime = Date.now()
let lastReport = 0

const discoveredPools = new Map<string, DiscoveredPool>()

// Load existing pools from file
const existingPools = loadPools(OUTPUT_FILE)
for (const [address, pool] of existingPools) {
    discoveredPools.set(address, {
        address: pool.address,
        providerName: pool.providerName,
        poolType: pool.poolType,
        tokens: new Set(pool.tokens)
    })
}
console.log(`Loaded ${discoveredPools.size} existing pools from ${OUTPUT_FILE}`)

// Fetch/Process blocks in batches
for (let fromBlock = fromBlockBase; fromBlock < roundedBlock; fromBlock += BATCH_SIZE) {
    batchNumber++
    const toBlock = Math.min(fromBlock + BATCH_SIZE - 1, roundedBlock - 1)
    const blockRangeKey = `logs_${fromBlock}_${toBlock}`

    let logs = discoveredPoolsDb.get(blockRangeKey) as Log[] | undefined

    if (!logs) {
        console.time(`Fetching logs from block ${fromBlock} to ${toBlock}`)
        logs = await catchUpRPC.getLogs({
            fromBlock: BigInt(fromBlock),
            toBlock: BigInt(toBlock),
        })
        console.timeEnd(`Fetching logs from block ${fromBlock} to ${toBlock}`)

        // Store logs in database with block range as key
        discoveredPoolsDb.put(blockRangeKey, logs)
    }

    // Process logs with all providers
    await Promise.all(providers.map(async (provider) => {
        const swapEvents = await provider.processLogs(logs, cachedRPC)
        for (const event of swapEvents) {
            const poolKey = event.pool.toLowerCase()

            if (!discoveredPools.has(poolKey)) {
                discoveredPools.set(poolKey, {
                    address: poolKey,
                    providerName: event.providerName,
                    poolType: event.poolType,
                    tokens: new Set([event.tokenIn, event.tokenOut])
                })
            } else {
                // Add new tokens to existing pool
                const pool = discoveredPools.get(poolKey)!
                pool.tokens.add(event.tokenIn)
                pool.tokens.add(event.tokenOut)
            }
        }
    }))

    // Calculate progress and ETA
    const batchesRemaining = totalBatches - batchNumber
    const avgTimePerBatch = (Date.now() - startTime) / batchNumber
    const etaMs = avgTimePerBatch * batchesRemaining
    const etaMinutes = Math.floor(etaMs / 60000)
    const etaSeconds = Math.floor((etaMs % 60000) / 1000)

    if (Date.now() - lastReport > 1000) {
        lastReport = Date.now()
        console.log(`Processed logs from block ${fromBlock} to ${toBlock} | Batch ${batchNumber}/${totalBatches} | ${totalBatches - batchNumber} remaining | ETA: ${etaMinutes}m ${etaSeconds}s | Pools found: ${discoveredPools.size}`)
    }
}

console.log(`Discovery complete. Found ${discoveredPools.size} unique pools`)

// Write pools to file
console.log(`Writing pools to ${OUTPUT_FILE}`)
savePools(OUTPUT_FILE, discoveredPools.values())
console.log(`Wrote ${discoveredPools.size} pools to ${OUTPUT_FILE}`)

process.exit(0)