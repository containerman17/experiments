import { createPublicClient, http, parseUnits, type Address, encodeFunctionData, keccak256, encodeAbiParameters, padHex } from 'viem'
import { avalanche } from 'viem/chains'
import fs from 'fs'
import { getRpcUrl } from '../../pkg/rpc.ts'

const RPC_URL = getRpcUrl()
const USDC = '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e' as Address
const WAVAX = '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7' as Address
const ROUTER = process.env.ROUTER_CONTRACT!.toLowerCase() as Address

const lfj_v2_pool = '0x864d4e5ee7318e97483db7eb0912e09f161516ea' as Address

const hayabusaAbi = JSON.parse(fs.readFileSync('./contracts/Hayabusa.json', 'utf-8')).abi

const client = createPublicClient({
    chain: avalanche,
    transport: http(RPC_URL)
})

async function traceQuote() {
    const amountIn = parseUnits('1', 6)

    const data = encodeFunctionData({
        abi: hayabusaAbi,
        functionName: 'quote',
        args: [
            [lfj_v2_pool],
            [3], // LFJ_V2
            [USDC, WAVAX],
            amountIn
        ]
    })

    const slot = 9
    const storageSlot = keccak256(
        encodeAbiParameters(
            [{ type: 'address' }, { type: 'uint256' }],
            [ROUTER, BigInt(slot)]
        )
    )
    const storageValue = padHex(`0x${amountIn.toString(16)}`, { size: 32 })

    console.log('Tracing call to Hayabusa.quote...')

    const response = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'debug_traceCall',
            params: [
                {
                    from: '0x0000000000000000000000000000000000000000',
                    to: ROUTER,
                    data: data
                },
                'latest',
                {
                    stateOverrides: {
                        [USDC]: {
                            stateDiff: {
                                [storageSlot]: storageValue
                            }
                        }
                    },
                    tracer: 'callTracer'
                }
            ]
        })
    })

    const result = await response.json()
    console.log(JSON.stringify(result, null, 2))
}

traceQuote().catch(console.error)
