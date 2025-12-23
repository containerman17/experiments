// Debug script to find the first revert when quoting USDC -> WAVAX using Hayabusa
// Uses the debug RPC node defined in .env via getRpcUrl()

import type { Address } from 'viem'
import { loadPools } from '../../pkg/poolsdb/PoolLoader.ts'
import { Hayabusa } from '../../pkg/Hayabusa.ts'
import { getRpcUrl } from '../../pkg/rpc.ts'

// Top-level await is used as per project conventions

const RPC_URL = getRpcUrl() // Debug node URL
const HAYABUSA_ADDRESS = process.env.ROUTER_CONTRACT as Address
const POOLS_FILE = './experiments/01_discover_pools/pools.txt'
const USDC = '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e'
const WAVAX = '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7'

// Load pools
const pools = loadPools(POOLS_FILE)
console.log(`Loaded ${pools.size} pools`)

// Filter USDC-WAVAX pools
const usdcWavaxPools = Array.from(pools.values()).filter(pool => {
    const tokens = pool.tokens.map(t => t.toLowerCase())
    return tokens.includes(USDC) && tokens.includes(WAVAX)
})

console.log(`Found ${usdcWavaxPools.length} USDC-WAVAX pools`)

// Create Hayabusa instance using the debug RPC URL
const hayabusa = new Hayabusa(RPC_URL, HAYABUSA_ADDRESS)

const amountIn = 1_000_000n // 10 USDC (6 decimals)

let firstRevertLogged = false

for (const pool of usdcWavaxPools) {
    const results = await hayabusa.quote([
        {
            path: [{
                pool: pool.address,
                poolType: pool.poolType,
                tokenIn: USDC,
                tokenOut: WAVAX
            }],
            amountIn
        }
    ])

    const result = results[0]
    if (result.error && !firstRevertLogged) {
        console.log('--- First revert encountered ---')
        console.log(`Provider: ${pool.providerName}`)
        console.log(`Pool: ${pool.address}`)
        console.log(`Error: ${result.error}`)
        // The raw call arguments are not directly exposed by Hayabusa.
        // In a real debug scenario you would use the RPC debug endpoint to
        // simulate the call and retrieve the revert data. Here we simply log
        // the information we have.
        firstRevertLogged = true
        // Break after the first revert as requested
        break
    }
}

if (!firstRevertLogged) {
    console.log('No revert errors were encountered in the USDC‑WAVAX pools.')
}
