import { createPublicClient, http, parseUnits, type Address, encodeFunctionData, decodeErrorResult } from 'viem'
import { avalanche } from 'viem/chains'
import 'dotenv/config'
import fs from 'fs'

const RPC_URL = 'http://167.235.8.126:9650/ext/bc/C/rpc'
const USDC = '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e' as Address
const WAVAX = '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7' as Address
const ROUTER = '0xcc57b84a9b9c7028900a571a739c59032f265030' as Address

const hayabusaAbi = JSON.parse(fs.readFileSync('./contracts/Hayabusa.json', 'utf-8')).abi

const client = createPublicClient({
    chain: avalanche,
    transport: http(RPC_URL)
})

async function debugQuote() {
    const amountIn = parseUnits('1', 6)
    const pool = '0x864d4e5ee7318e97483db7eb0912e09f161516ea' as Address // LFJ V2 USDC/WAVAX

    console.log(`Debugging quote for pool ${pool}...`)

    try {
        const result = await client.call({
            account: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', // Use a real address to avoid 0x0 issues
            to: ROUTER,
            data: encodeFunctionData({
                abi: hayabusaAbi,
                functionName: 'quote',
                args: [[pool], [3], [USDC, WAVAX], amountIn]
            }),
            stateOverride: [{
                address: USDC,
                stateDiff: [{
                    slot: '0x92d0bc3371778edd7c5339bf1175c2ef15b921b0786a632a5e2c5d446d1c1091',
                    value: '0x00000000000000000000000000000000000000000000000000000000000f4240'
                }]
            }]
        })
        console.log('Call succeeded unexpectedly (it was supposed to revert or return data)')
    } catch (e: any) {
        console.log('Caught error during call:')
        if (e.data) {
            console.log('Error data:', e.data)
            try {
                const decoded = decodeErrorResult({
                    abi: hayabusaAbi,
                    data: e.data
                })
                console.log('Decoded error:', decoded)
            } catch {
                console.log('Could not decode error with Hayabusa ABI')
            }
        } else {
            console.log(e)
        }
    }
}

debugQuote().catch(console.error)
