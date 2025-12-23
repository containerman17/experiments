import * as lmdb from 'lmdb'
import { fileURLToPath } from 'url'
import path from 'path'
import { providers } from "../../../pkg/providers/index.ts"
import { createPublicClient, webSocket, http } from "viem"
import { avalanche } from 'viem/chains'
import { getCachedRpcClient } from '../../../pkg/CachedRpcClient.ts'
import { getRpcUrl, getWsRpcUrl } from '../../../pkg/rpc.ts'
import { DollarAmounts } from '../../../pkg/poolsdb/DollarAmounts.ts'

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
import { loadPools } from "../../../pkg/poolsdb/PoolLoader.ts"
import { DollarPrice } from '../../../pkg/poolsdb/DollarPrice.ts'

// Load pools from file
const poolsFilePath = path.resolve(path.join(__dirname, "../../../experiments/01_discover_pools/pools.txt"))
const pools = loadPools(poolsFilePath)


const ROUTER_CONTRACT = process.env.ROUTER_CONTRACT || ""
if (!ROUTER_CONTRACT) throw new Error("ROUTER_CONTRACT env var not set")

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

wsClient.watchBlockNumber({
    onBlockNumber: (blockNumber: bigint) => {
        lastBlockNumber = Number(blockNumber)
    },
    onError: (error) => {
        console.error(error)
        process.exit(1)
    }
})

const cachedRPC = getCachedRpcClient(RPC_URL)
const hayabusa = new Hayabusa(RPC_URL, ROUTER_CONTRACT)
const dollarAmounts = new DollarAmounts(poolsFilePath, hayabusa)
const dollarPrice = new DollarPrice(dollarAmounts, pools, hayabusa)

dollarPrice.subscribeToPrices(async (price) => {
    const symbolIn = await cachedRPC.getSymbol(price.tokenIn)
    const symbolOut = await cachedRPC.getSymbol(price.tokenOut)
    const decimalsIn = await cachedRPC.getDecimals(price.tokenIn)
    const decimalsOut = await cachedRPC.getDecimals(price.tokenOut)

    if (price.error) {
        console.log(`❌ FAIL: ${symbolIn} -> ${symbolOut} @ ${price.providerName} ${price.pool} | ${price.error}`)
    } else {
        console.log(`${(Number(price.amountIn) / 10 ** decimalsIn).toFixed(8)} ${symbolIn} -> ${(Number(price.amountOut) / 10 ** decimalsOut).toFixed(8)} ${symbolOut} @ ${price.providerName} ${price.pool}`)
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

    const poolsToInvalidate = new Set<string>()
    await Promise.all(providers.map(async (provider) => {
        const swapEvents = await provider.processLogs(logs, cachedRPC)
        for (const event of swapEvents) {
            poolsToInvalidate.add(event.pool.toLowerCase())
        }
    }))

    // Invalidate cache for affected pools
    if (poolsToInvalidate.size > 0) {
        //TODO: clear cache
    }

    await dollarPrice.fetchPrices()

    if ((lastProcessedBlockNumber + 1) === toBlock) {
        console.log(`Processed block ${toBlock}`)
    } else {
        console.log(`Processed ${toBlock - lastProcessedBlockNumber} blocks from ${lastProcessedBlockNumber + 1}`)
    }
    lastProcessedBlockNumber = toBlock
}