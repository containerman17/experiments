// Debug script to trace the reverting eth_call using debug_traceCall
// This will show exactly where in the execution the revert occurs

import { encodeFunctionData, type Address } from 'viem'
import { readFileSync } from 'fs'
import { getOverride } from '../../pkg/overrides/getOverride.ts'
import { loadPools } from '../../pkg/poolsdb/PoolLoader.ts'
import { getRpcUrl } from '../../pkg/rpc.ts'

const RPC_URL = getRpcUrl()
const HAYABUSA_ADDRESS = process.env.ROUTER_CONTRACT as Address
const POOLS_FILE = './experiments/01_discover_pools/pools.txt'
const USDC = '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e' as Address
const WAVAX = '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7' as Address

// Load the Hayabusa ABI
const hayabusaAbi = JSON.parse(
    readFileSync('./contracts/Hayabusa.json', 'utf-8')
).abi

// Load pools and find the first USDC-WAVAX pool that will revert
const pools = loadPools(POOLS_FILE)
const usdcWavaxPools = Array.from(pools.values()).filter(p => {
    const tokens = p.tokens.map(t => t.toLowerCase())
    return tokens.includes(USDC.toLowerCase()) && tokens.includes(WAVAX.toLowerCase())
})

// The first reverting pool from the user's output is:
// uniswap_v3 0x11476e10eb79ddffa6f2585be526d2bd840c3e20
const revertingPool = usdcWavaxPools.find(
    p => p.address.toLowerCase() === '0x11476e10eb79ddffa6f2585be526d2bd840c3e20'
)

if (!revertingPool) {
    console.error('Could not find the reverting pool!')
    process.exit(1)
}

console.log('Debugging pool:', revertingPool.address)
console.log('Provider:', revertingPool.providerName)
console.log('Pool type:', revertingPool.poolType)

const amountIn = 1_000_000n // 10 USDC (6 decimals)

// Build the call data
const data = encodeFunctionData({
    abi: hayabusaAbi,
    functionName: 'quote',
    args: [[revertingPool.address], [revertingPool.poolType], [USDC, WAVAX], amountIn]
})

// Build state override - tokens should be on the contract for quote()
const overrideObj = getOverride(USDC, HAYABUSA_ADDRESS, amountIn)
const stateOverride: Record<string, { stateDiff: Record<string, string> }> = {}

if (overrideObj) {
    for (const [addr, override] of Object.entries(overrideObj)) {
        stateOverride[addr] = { stateDiff: override.stateDiff }
    }
}

// Build the eth_call request
const callRequest = {
    from: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    to: HAYABUSA_ADDRESS,
    data
}

console.log('\n--- Call Request ---')
console.log(JSON.stringify(callRequest, null, 2))
console.log('\n--- State Override ---')
console.log(JSON.stringify(stateOverride, null, 2))

// First, try the regular eth_call to confirm it reverts
console.log('\n--- Regular eth_call (should revert) ---')
const regularCall = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [callRequest, 'latest', stateOverride]
    })
})

const regularResult = await regularCall.json()
console.log(JSON.stringify(regularResult, null, 2))

// Now use debug_traceCall to see where it reverts
console.log('\n--- debug_traceCall (detailed trace) ---')
const traceCall = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'debug_traceCall',
        params: [
            callRequest,
            'latest',
            {
                tracer: 'callTracer',
                stateOverrides: stateOverride
            }
        ]
    })
})

const traceResult = await traceCall.json()
console.log(JSON.stringify(traceResult, null, 2))
