// Find all pools containing both WAVAX and USDC, quote 1 USDC -> WAVAX using Hayabusa

import 'dotenv/config'
import type { Address } from 'viem'
import { loadPools } from '../../pkg/poolsdb/PoolLoader.ts'
import { Hayabusa } from '../../pkg/Hayabusa.ts'

const RPC_URL = 'http://167.235.8.126:9650/ext/bc/C/rpc'
const HAYABUSA_ADDRESS = '0xcc57b84a9b9c7028900a571a739c59032f265030' as Address
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

console.log(`\nFound ${usdcWavaxPools.length} USDC-WAVAX pools:`)
for (const pool of usdcWavaxPools) {
    console.log(`  ${pool.providerName} - ${pool.address} (type: ${pool.poolType})`)
}

// Create Hayabusa instance
const hayabusa = new Hayabusa(RPC_URL, HAYABUSA_ADDRESS)

// Build quote requests: 1 USDC (1_000_000 raw) -> WAVAX for each pool
const amountIn = 1_000_000n // 10 USDC in raw units (6 decimals)

console.log(`\n=== Quoting 10 USDC -> WAVAX ===\n`)

let bestQuote: { pool: string; provider: string; wavaxOut: number; usdPerWavax: number } | null = null

for (const pool of usdcWavaxPools) {
    const results = await hayabusa.quote([{
        path: [{
            pool: pool.address,
            poolType: pool.poolType,
            tokenIn: USDC,
            tokenOut: WAVAX
        }],
        amountIn
    }])

    const result = results[0]
    if (result.error) {
        // Only truly expected: pool has no liquidity in V3 tick range
        const isNoLiquidity = result.error.includes('SPL') // LFJ "safe price lower" error

        if (isNoLiquidity) {
            console.log(`${pool.providerName} ${pool.address.slice(0, 10)}...: NO_LIQUIDITY`)
        } else {
            // Log full error but don't crash - we want to see what's happening
            console.log(`${pool.providerName} ${pool.address.slice(0, 10)}...: ERROR - ${result.error}`)
        }

    } else {
        const wavaxOut = Number(result.amountOut) / 1e18
        const usdPerWavax = 1 / wavaxOut
        console.log(`${pool.providerName} ${pool.address.slice(0, 10)}...: ${wavaxOut.toFixed(6)} WAVAX (~$${usdPerWavax.toFixed(2)}/WAVAX)`)

        if (!bestQuote || wavaxOut > bestQuote.wavaxOut) {
            bestQuote = { pool: pool.address, provider: pool.providerName, wavaxOut, usdPerWavax }
        }
    }
}


if (bestQuote) {
    console.log(`\n=== BEST QUOTE ===`)
    console.log(`Provider: ${bestQuote.provider}`)
    console.log(`Pool: ${bestQuote.pool}`)
    console.log(`Output: ${bestQuote.wavaxOut.toFixed(8)} WAVAX`)
    console.log(`Price: ~$${bestQuote.usdPerWavax.toFixed(2)}/WAVAX`)
}
