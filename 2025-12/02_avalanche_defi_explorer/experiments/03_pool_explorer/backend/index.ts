import * as lmdb from 'lmdb'
import { fileURLToPath } from 'url'
import path from 'path'
import { providers } from "../../../pkg/providers/index.ts"
import { createPublicClient, webSocket, http } from "viem"
import { avalanche } from 'viem/chains'
import { CachedRpcClient } from '../../../pkg/CachedRpcClient.ts'
import { getRpcUrl, getWsRpcUrl } from '../../../pkg/rpc.ts'

const RPC_URL = getRpcUrl()
const WS_RPC = getWsRpcUrl()
const BATCH_SIZE = 100

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const poolsDataDir = path.resolve(path.join(__dirname, "../../../data/poolsdb/"))
console.log(poolsDataDir)
const poolsLmdb = lmdb.open(poolsDataDir, {
    compression: true,
})

import { Hayabusa } from "../../../pkg/Hayabusa.ts"
import { DollarPriceStream } from "../../../pkg/poolsdb/DollarPriceStream.ts"
import { loadPools } from "../../../pkg/poolsdb/PoolLoader.ts"

// Load pools from file
const poolsFilePath = path.resolve(path.join(__dirname, "../../../experiments/01_discover_pools/pools.txt"))
const pools = loadPools(poolsFilePath)

const ROUTER_CONTRACT = process.env.ROUTER_CONTRACT || ""
if (!ROUTER_CONTRACT) {
    console.warn("ROUTER_CONTRACT env var not set, DollarPriceStream might fail")
    process.exit(1)
}

const hayabusa = new Hayabusa(RPC_URL, ROUTER_CONTRACT)
const dollarPriceStream = new DollarPriceStream(pools, hayabusa)

// Setup CachedRPC for processing logs
const cachedRPC = new CachedRpcClient(RPC_URL, poolsLmdb.openDB({
    name: 'cached_rpc',
    compression: true
}))

const wsClient = createPublicClient({
    chain: avalanche,
    transport: webSocket(WS_RPC),
})

const httpClient = createPublicClient({
    chain: avalanche,
    transport: http(RPC_URL),
})

let lastBlockNumber = Number(await wsClient.getBlockNumber())
const catchUpTo = Math.floor(lastBlockNumber / BATCH_SIZE) * BATCH_SIZE
let lastProcessedBlockNumber = catchUpTo

console.log(`Starting from block ${catchUpTo}`)

// Subscribe to all price updates and log them
dollarPriceStream.subscribeToPriceUpdates((priceUpdate) => {
    console.log(`Price update: ${priceUpdate.pool} ${priceUpdate.tokenIn} -> ${priceUpdate.tokenOut}: ${priceUpdate.amountIn} -> ${priceUpdate.amountOut}`)
})

// Initial price fetch
console.log("Starting initial price fetch...")
await dollarPriceStream.refetchPrices()
console.log("Initial price fetch complete")

wsClient.watchBlockNumber({
    onBlockNumber: (blockNumber: bigint) => {
        lastBlockNumber = Number(blockNumber)
    },
    onError: (error) => {
        console.error(error)
        process.exit(1)
    }
})

while (true) {
    if (lastBlockNumber <= lastProcessedBlockNumber) {
        await new Promise(resolve => setTimeout(resolve, 1))
        continue
    }
    const toBlock = Math.min(lastBlockNumber, lastProcessedBlockNumber + BATCH_SIZE)
    const logs = await httpClient.getLogs({
        fromBlock: BigInt(lastProcessedBlockNumber + 1),
        toBlock: BigInt(toBlock),
    })

    // Process logs with all providers directly
    const poolsToInvalidate = new Set<string>()
    await Promise.all(providers.map(async (provider) => {
        const swapEvents = await provider.processLogs(logs, cachedRPC)
        for (const event of swapEvents) {
            poolsToInvalidate.add(event.pool.toLowerCase())
        }
    }))

    // Invalidate cache for affected pools
    if (poolsToInvalidate.size > 0) {
        dollarPriceStream.cacheBustedCallback(Array.from(poolsToInvalidate))
        // Refetch prices after cache invalidation
        await dollarPriceStream.refetchPrices()
    }

    if ((lastProcessedBlockNumber + 1) === toBlock) {
        console.log(`Processed block ${toBlock}`)
    } else {
        console.log(`Processed ${toBlock - lastProcessedBlockNumber} blocks from ${lastProcessedBlockNumber + 1}`)
    }
    lastProcessedBlockNumber = toBlock
}