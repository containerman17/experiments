// Find all pools containing both WAVAX and USDC, quote USDC -> WAVAX, then best output back to USDC
// Uses Hayabusa batching for parallel execution

import type { Address } from 'viem'
import { loadPools } from '../../pkg/poolsdb/PoolLoader.ts'
import { Hayabusa, type QuoteRequest, type QuoteResult } from '../../pkg/Hayabusa.ts'
import { getRpcUrl } from '../../pkg/rpc.ts'

const RPC_URL = getRpcUrl()
const HAYABUSA_ADDRESS = process.env.ROUTER_CONTRACT as Address
const POOLS_FILE = './experiments/01_discover_pools/pools.txt'
const USDC = '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e'
const WAVAX = '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7'

// Load pools
const pools = loadPools(POOLS_FILE)
console.log(`Loaded ${pools.size} pools`)

// Filter pools that have both USDC and WAVAX
const usdcWavaxPools = Array.from(pools.values()).filter(pool => {
    const tokens = pool.tokens.map(t => t.toLowerCase())
    return tokens.includes(USDC) && tokens.includes(WAVAX)
})

console.log(`\nFound ${usdcWavaxPools.length} USDC-WAVAX pools`)

// Create Hayabusa instance
const hayabusa = new Hayabusa(RPC_URL, HAYABUSA_ADDRESS)

// === Pass 1: Quoting 10 USDC -> WAVAX (Parallel) ===
const amountInUsdc = 10_000_000n // 10 USDC (6 decimals)
console.log(`\n=== STEP 1: Quoting 10 USDC -> WAVAX (Parallel) ===\n`)

const pass1Requests: QuoteRequest[] = usdcWavaxPools.map(pool => ({
    path: [{
        pool: pool.address,
        poolType: pool.poolType,
        tokenIn: USDC,
        tokenOut: WAVAX
    }],
    amountIn: amountInUsdc
}))

const results1 = await hayabusa.quote(pass1Requests)

let bestWavaxQuote: { pool: string; provider: string; amountOut: bigint; wavaxOut: number; usdPerWavax: number } | null = null

results1.forEach((result, i) => {
    const pool = usdcWavaxPools[i]
    if (result.error) {
        // console.log(`${pool.providerName} ${pool.address.slice(0, 10)}...: ERROR - ${result.error.slice(0, 50)}...`)
    } else {
        const wavaxOut = Number(result.amountOut) / 1e18
        const usdPerWavax = Number(amountInUsdc) / 1e6 / wavaxOut
        console.log(`${pool.providerName} ${pool.address.slice(0, 10)}...: ${wavaxOut.toFixed(6)} WAVAX (~$${usdPerWavax.toFixed(2)}/WAVAX)`)

        if (!bestWavaxQuote || result.amountOut > bestWavaxQuote.amountOut) {
            bestWavaxQuote = { pool: pool.address, provider: pool.providerName, amountOut: result.amountOut, wavaxOut, usdPerWavax }
        }
    }
})

if (!bestWavaxQuote) {
    console.error('No successful USDC -> WAVAX quotes found.')
    process.exit(1)
}

// TypeScript doesn't understand process.exit() terminates, so we assert non-null
const bestWavax = bestWavaxQuote!

console.log(`\nBEST USDC -> WAVAX: ${bestWavax.wavaxOut.toFixed(6)} WAVAX in ${bestWavax.provider} (${bestWavax.pool})`)

// === Pass 2: Quoting best WAVAX amount back to USDC (Parallel) ===
const amountInWavax = bestWavax.amountOut
console.log(`\n=== STEP 2: Quoting ${bestWavax.wavaxOut.toFixed(6)} WAVAX -> USDC (Parallel) ===\n`)

const pass2Requests: QuoteRequest[] = usdcWavaxPools.map(pool => ({
    path: [{
        pool: pool.address,
        poolType: pool.poolType,
        tokenIn: WAVAX,
        tokenOut: USDC
    }],
    amountIn: amountInWavax
}))

const results2 = await hayabusa.quote(pass2Requests)

let bestUsdcReturn: { pool: string; provider: string; amountOut: bigint; usdcOut: number; wavaxPrice: number } | null = null

results2.forEach((result, i) => {
    const pool = usdcWavaxPools[i]
    if (result.error) {
        // console.log(`${pool.providerName} ${pool.address.slice(0, 10)}...: ERROR`)
    } else {
        const usdcOut = Number(result.amountOut) / 1e6
        const wavaxPrice = usdcOut / (Number(amountInWavax) / 1e18)
        console.log(`${pool.providerName} ${pool.address.slice(0, 10)}...: ${usdcOut.toFixed(4)} USDC (~$${wavaxPrice.toFixed(2)}/WAVAX)`)

        if (!bestUsdcReturn || result.amountOut > bestUsdcReturn.amountOut) {
            bestUsdcReturn = { pool: pool.address, provider: pool.providerName, amountOut: result.amountOut, usdcOut, wavaxPrice }
        }
    }
})

console.log(`\n=== FINAL RESULTS ===`)
console.log(`Best Buy (Step 1):  ${bestWavax.wavaxOut.toFixed(8)} WAVAX (~$${bestWavax.usdPerWavax.toFixed(2)})`)
if (bestUsdcReturn) {
    const profitUsdc = bestUsdcReturn.usdcOut - 10
    console.log(`Best Sell (Step 2): ${bestUsdcReturn.usdcOut.toFixed(4)} USDC (~$${bestUsdcReturn.wavaxPrice.toFixed(2)})`)
    console.log(`Net Return:        ${profitUsdc.toFixed(4)} USDC (${((profitUsdc / 10) * 100).toFixed(2)}%)`)
}
