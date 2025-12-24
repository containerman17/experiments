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

import { Hayabusa } from "../../../pkg/Hayabusa.ts"
import { DollarPrice } from '../../../pkg/poolsdb/DollarPrice.ts'
import { PoolMaster } from '../../../pkg/poolsdb/PoolMaster.ts'

// Load pools from file
const poolsFilePath = path.resolve(path.join(__dirname, "../../../experiments/01_discover_pools/pools.txt"))
const poolmaster = new PoolMaster(poolsFilePath)
const topCoins = poolmaster.getAllCoins(2, 0, "combined").slice(0, 10)
const cachedRPC = getCachedRpcClient(RPC_URL)

const topCoinNames = await Promise.all(topCoins.map(c => cachedRPC.getSymbol(c)))

const pools = poolmaster.getPoolsWithLimitedCoinSet(topCoins)
console.log(`Working with ${topCoinNames.length} top coins in ${[...pools.values()].length} pools: \n${topCoinNames.join(", ")}`)


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

let lastBlockNumber = Number(await httpClient.getBlockNumber())
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

const hayabusa = new Hayabusa(RPC_URL, ROUTER_CONTRACT)
const dollarAmounts = new DollarAmounts(poolsFilePath, hayabusa)
const dollarPrice = new DollarPrice(dollarAmounts, pools, hayabusa)

dollarPrice.subscribeToPrices(async (prices) => {
    let nonZeroPrices = 0
    let zeroPrices = 0
    let errors = 0
    for (const price of prices) {
        // const symbolIn = await cachedRPC.getSymbol(price.tokenIn)
        // const symbolOut = await cachedRPC.getSymbol(price.tokenOut)
        // const decimalsIn = await cachedRPC.getDecimals(price.tokenIn)
        // const decimalsOut = await cachedRPC.getDecimals(price.tokenOut)

        // if (price.error) {
        //     console.log(`❌ FAIL: ${symbolIn} -> ${symbolOut} @ ${price.providerName} ${price.pool} | ${price.error}`)
        // } else {
        //     console.log(`${(Number(price.amountIn) / 10 ** decimalsIn).toFixed(8)} ${symbolIn} -> ${(Number(price.amountOut) / 10 ** decimalsOut).toFixed(8)} ${symbolOut} @ ${price.providerName} ${price.pool}`)
        // }
        if (price.error) {
            errors++
            const symbolIn = await cachedRPC.getSymbol(price.tokenIn)
            const symbolOut = await cachedRPC.getSymbol(price.tokenOut)
            console.log(`❌ FAIL: ${symbolIn} -> ${symbolOut} @ ${price.providerName} ${price.pool} | ${price.error}`)

        } else if (price.amountOut > 0) {
            nonZeroPrices++
        } else {
            zeroPrices++
        }
    }
    console.log(`Non-zero prices: ${nonZeroPrices}, zero prices: ${zeroPrices}, errors: ${errors}`)
})

let firstRun = true
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
    if (poolsToInvalidate.size > 0 || firstRun) {
        dollarPrice.bustCaches(Array.from(poolsToInvalidate))
        console.time(`Invalidating cache for ${poolsToInvalidate.size} pools`)
        await dollarPrice.fetchPrices()
        console.timeEnd(`Invalidating cache for ${poolsToInvalidate.size} pools`)
        firstRun = false

    }


    if ((lastProcessedBlockNumber + 1) === toBlock) {
        console.log(`Processed block ${toBlock}`)
    } else {
        console.log(`Processed ${toBlock - lastProcessedBlockNumber} blocks from ${lastProcessedBlockNumber + 1}`)
    }
    lastProcessedBlockNumber = toBlock
}