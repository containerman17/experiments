import { fileURLToPath } from 'url'
import path from 'path'
import { providers } from "../../../pkg/providers/index.ts"
import { createPublicClient, webSocket, http } from "viem"
import { avalanche } from 'viem/chains'
import { getCachedRpcClient } from '../../../pkg/CachedRpcClient.ts'
import { getRpcUrl, getWsRpcUrl } from '../../../pkg/rpc.ts'
import { DollarAmounts } from '../../../pkg/poolsdb/DollarAmounts.ts'
import { WebSocketServer } from 'ws'
import express from 'express'
import { createServer } from 'http'
import { createServer as createViteServer } from 'vite'

import { Hayabusa } from "../../../pkg/Hayabusa.ts"
import { DollarPrice } from '../../../pkg/poolsdb/DollarPrice.ts'
import { PoolMaster } from '../../../pkg/poolsdb/PoolMaster.ts'
import { type PoolPriceData, getPriceKey } from '../src/types.ts'

const RPC_URL = getRpcUrl()
const WS_RPC = getWsRpcUrl()
const BATCH_SIZE = 100
const PORT = 5173

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// -- Initialization --

const poolsFilePath = path.resolve(path.join(__dirname, "../../../experiments/01_discover_pools/pools.txt"))
const poolmaster = new PoolMaster(poolsFilePath)
const topCoins = poolmaster.getAllCoins(2, 0, "combined").slice(0, 100)
const cachedRPC = getCachedRpcClient(RPC_URL)

const pools = poolmaster.getPoolsWithLimitedCoinSet(topCoins)
const ROUTER_CONTRACT = process.env.ROUTER_CONTRACT || ""
if (!ROUTER_CONTRACT) throw new Error("ROUTER_CONTRACT env var not set")

const hayabusa = new Hayabusa(RPC_URL, ROUTER_CONTRACT)
const dollarAmounts = new DollarAmounts(poolsFilePath, hayabusa)
const dollarPrice = new DollarPrice(dollarAmounts, pools, hayabusa, 100n)

// -- State Management --

const fullState = new Map<string, PoolPriceData>()

function broadcast(message: any) {
    const payload = JSON.stringify(message)
    wss.clients.forEach((client) => {
        if (client.readyState === 1) client.send(payload)
    })
}

dollarPrice.subscribeToPrices(async (prices) => {
    const patch: PoolPriceData[] = await Promise.all(prices.map(async p => {
        const [symbolIn, symbolOut, decIn, decOut] = await Promise.all([
            cachedRPC.getSymbol(p.tokenIn),
            cachedRPC.getSymbol(p.tokenOut),
            cachedRPC.getDecimals(p.tokenIn),
            cachedRPC.getDecimals(p.tokenOut)
        ])
        return {
            pool: p.pool,
            tokenIn: p.tokenIn,
            tokenOut: p.tokenOut,
            tokenInSymbol: symbolIn,
            tokenOutSymbol: symbolOut,
            tokenInDecimals: decIn,
            tokenOutDecimals: decOut,
            amountIn: p.amountIn.toString(),
            amountOut: p.error ? "0" : p.amountOut.toString(),
            providerName: p.providerName,
            error: p.error,
            updatedAt: Date.now()
        }
    }))

    // Apply patch to full state
    for (const p of patch) {
        fullState.set(getPriceKey(p), p)
    }

    // Broadcast patch
    broadcast({ type: 'patch', data: patch })
})

// -- Server & WebSocket --

const app = express()
const server = createServer(app)
const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' })
app.use(vite.middlewares)

const wss = new WebSocketServer({ server })

wss.on('connection', (ws) => {
    console.log('Client connected')
    // Send full state as the first "patch" (snapshot)
    if (fullState.size > 0) {
        ws.send(JSON.stringify({ type: 'patch', data: Array.from(fullState.values()) }))
    }
    ws.on('close', () => console.log('Client disconnected'))
})

server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`))

// -- Blockchain Monitoring --

const httpClient = createPublicClient({ chain: avalanche, transport: http(RPC_URL) })
const wsClient = createPublicClient({ chain: avalanche, transport: webSocket(WS_RPC) })

let lastBlockNumber = Number(await httpClient.getBlockNumber())
let lastProcessedBlockNumber = Math.floor(lastBlockNumber / BATCH_SIZE) * BATCH_SIZE

wsClient.watchBlockNumber({
    onBlockNumber: (num) => { lastBlockNumber = Number(num) },
    onError: (err) => { console.error(err); process.exit(1) }
})

let firstRun = true
while (true) {
    if (lastBlockNumber <= lastProcessedBlockNumber) {
        await new Promise(r => setTimeout(r, 1))
        continue
    }

    const toBlock = Math.min(lastBlockNumber, lastProcessedBlockNumber + BATCH_SIZE)
    const logs = await httpClient.getLogs({
        fromBlock: BigInt(lastProcessedBlockNumber + 1),
        toBlock: BigInt(toBlock),
    })

    const poolsToInvalidate = new Set<string>()
    await Promise.all(providers.map(async (provider) => {
        const events = await provider.processLogs(logs, cachedRPC)
        events.forEach(e => poolsToInvalidate.add(e.pool.toLowerCase()))
    }))

    if (poolsToInvalidate.size > 0 || firstRun) {
        dollarPrice.bustCaches(Array.from(poolsToInvalidate))
        const poolProviders = [...new Set(Array.from(poolsToInvalidate).map(p => pools.get(p)?.providerName))]
        console.time(`Update ${poolsToInvalidate.size} pools ${poolProviders.join(', ')}`)
        await dollarPrice.fetchPrices()
        console.timeEnd(`Update ${poolsToInvalidate.size} pools ${poolProviders.join(', ')}`)
        firstRun = false
    }

    console.log(`Processed up to ${toBlock}`)
    lastProcessedBlockNumber = toBlock
}