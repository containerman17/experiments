// Debug script using debug_traceCall to get detailed revert info for the first failing USDC->WAVAX quote
// Requires the RPC endpoint to support the `debug_traceCall` method (e.g., a debug node)

import type { Address } from 'viem'
import { loadPools } from '../../pkg/poolsdb/PoolLoader.ts'
import { Hayabusa } from '../../pkg/Hayabusa.ts'
import { getRpcUrl } from '../../pkg/rpc.ts'
import { getOverride } from '../../pkg/overrides/getOverride.ts'
import { encodeFunctionData } from 'viem'
import { readFileSync } from 'fs'

// Top‑level await as per project conventions

const RPC_URL = getRpcUrl()
const HAYABUSA_ADDRESS = process.env.ROUTER_CONTRACT as Address
const POOLS_FILE = './experiments/01_discover_pools/pools.txt'
const USDC = '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e'
const WAVAX = '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7'

const pools = loadPools(POOLS_FILE)
const usdcWavaxPools = Array.from(pools.values()).filter(p => {
    const toks = p.tokens.map(t => t.toLowerCase())
    return toks.includes(USDC) && toks.includes(WAVAX)
})

const hayabusa = new Hayabusa(RPC_URL, HAYABUSA_ADDRESS)

const amountIn = 1_000_000n // 10 USDC (6 decimals)

let firstRevert = false

for (const pool of usdcWavaxPools) {
    // Build the call data exactly as Hayabusa does
    const data = encodeFunctionData({
        abi: (function () { // lazy load ABI from Hayabusa contract JSON
            const json = JSON.parse(readFileSync(`${import.meta.dirname}/../contracts/Hayabusa.json`, 'utf-8'))
            return json.abi
        })(),
        functionName: 'quote',
        args: [[pool.address], [pool.poolType], [USDC, WAVAX], amountIn]
    })

    const overrideObj = getOverride(USDC, HAYABUSA_ADDRESS, amountIn)
    const stateOverride = overrideObj ? [{
        address: HAYABUSA_ADDRESS,
        stateDiff: Object.entries(overrideObj[USDC].stateDiff).map(([slot, value]) => ({ slot, value }))
    }] : undefined

    const callObject = {
        from: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
        to: HAYABUSA_ADDRESS,
        data,
        stateOverride
    }

    // Perform a normal quote first to see if it reverts
    const result = await hayabusa.quote([{ path: [{ pool: pool.address, poolType: pool.poolType, tokenIn: USDC, tokenOut: WAVAX }], amountIn }])
    const quoteRes = result[0]
    if (quoteRes.error && !firstRevert) {
        console.log('--- First revert detected (normal call) ---')
        console.log(`Provider: ${pool.providerName}`)
        console.log(`Pool: ${pool.address}`)
        console.log(`Error: ${quoteRes.error}`)
        console.log('--- Running debug_traceCall for detailed revert info ---')

        const payload = {
            jsonrpc: '2.0',
            id: 1,
            method: 'debug_traceCall',
            params: [callObject, 'latest', {}]
        }

        try {
            const resp = await fetch(RPC_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            })
            const json = await resp.json()
            console.log('debug_traceCall response:', JSON.stringify(json, null, 2))
        } catch (e) {
            console.error('Failed to call debug_traceCall:', e)
        }
        firstRevert = true
        break
    }
}

if (!firstRevert) {
    console.log('No revert encountered in any pool.')
}
