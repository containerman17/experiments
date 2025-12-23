// Find dollar quotes for all tokens in pools using multi-hop routes (1-4 hops)
// Uses PoolMaster.findRoutes() to discover routes and Hayabusa for quoting

import type { Address } from 'viem'
import { PoolMaster } from '../../pkg/poolsdb/PoolMaster.ts'
import { Hayabusa, type QuoteRequest, type Path } from '../../pkg/Hayabusa.ts'
import { getRpcUrl } from '../../pkg/rpc.ts'
import { getCachedRpcClient } from '../../pkg/CachedRpcClient.ts'

const RPC_URL = getRpcUrl()
const HAYABUSA_ADDRESS = process.env.ROUTER_CONTRACT as Address
const POOLS_FILE = './experiments/01_discover_pools/pools.txt'
const USDC = '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e'

const cachedRPCClient = getCachedRpcClient(RPC_URL)

// 1 USDC = 1_000_000 (6 decimals)
const ONE_DOLLAR = 1_000_000n

// Load pools and create PoolMaster
const poolMaster = new PoolMaster(POOLS_FILE)
const allCoins = poolMaster.getAllCoins()
console.log(`Found ${allCoins.length} unique tokens`)

// Create Hayabusa instance
const hayabusa = new Hayabusa(RPC_URL, HAYABUSA_ADDRESS)

const tokens = poolMaster.getAllCoins().slice(0, 5)
console.log(`Quoting 1 USDC -> each of ${tokens.length} tokens...`)

const fixedWidth = (str: string, length: number) => {
    if (str.length > length) return str.slice(0, length)
    return str.padEnd(length, ' ')
}

const DEBUG_LIMIT_PATHS = 1000


console.time('Path finding...')
for (let token of tokens) {
    const symbol = await cachedRPCClient.getSymbol(token)

    const routes = poolMaster.findRoutes(USDC, token, DEBUG_LIMIT_PATHS).slice(0, DEBUG_LIMIT_PATHS)

    const requests: QuoteRequest[] = routes.map(route => ({
        path: route,
        amountIn: ONE_DOLLAR
    }))

    const results = await hayabusa.quote(requests)
    const decimals = await cachedRPCClient.getDecimals(token)

    const bestQuote = results.sort((a, b) => Number(b.amountOut) - Number(a.amountOut))[0]
    const amountOut = Number(bestQuote.amountOut) / 10 ** decimals

    console.log(`${fixedWidth(symbol, 12)} ${amountOut.toFixed(6)} ${symbol} | ${routes.length} routes`)

    // Format and print the path: TokenA=>TokenB TokenB=>TokenC
    const pathStrings = []
    for (const leg of bestQuote.path) {
        const symIn = await cachedRPCClient.getSymbol(leg.tokenIn)
        const symOut = await cachedRPCClient.getSymbol(leg.tokenOut)
        pathStrings.push(`${symIn}=>${symOut}`)
    }
    console.log(`  Path: ${pathStrings.join(' ')}`)

    console.log('-'.repeat(50))
}
console.timeEnd('Path finding...')

process.exit(0)