// Debug the remaining pharaoh_v3 pool revert
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

// Find the pharaoh_v3 pool 0xa20c959b19f114e9c2d81547734cdc1110bd773d
const pools = loadPools(POOLS_FILE)
const targetPool = Array.from(pools.values()).find(
    p => p.address.toLowerCase() === '0xa20c959b19f114e9c2d81547734cdc1110bd773d'
)

if (!targetPool) {
    console.error('Could not find the pharaoh_v3 pool!')
    process.exit(1)
}

console.log('Debugging pool:', targetPool.address)
console.log('Provider:', targetPool.providerName)
console.log('Pool type:', targetPool.poolType)

const amountIn = 1_000_000n // 10 USDC (6 decimals)

// Build the call data
const data = encodeFunctionData({
    abi: hayabusaAbi,
    functionName: 'quote',
    args: [[targetPool.address], [targetPool.poolType], [USDC, WAVAX], amountIn]
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

console.log('\n--- debug_traceCall ---')
const traceCall = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
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
