/**
 * Test circular route quoting with whale pattern
 * Reproducing the 81 billion USDC bug with exact pools from quote_any.ts
 */
import 'dotenv/config'
import { createPublicClient, http, encodeFunctionData, decodeFunctionResult, type Address } from 'viem'
import { avalanche } from 'viem/chains'
import { getOverride } from '../../pkg/overrides/getOverride.ts'
import { readFileSync } from 'fs'

const RPC = process.env.RPC_URL!
const HAYABUSA = process.env.ROUTER_CONTRACT as Address
if (!HAYABUSA) throw new Error('ROUTER_CONTRACT not set')

const WHALE = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' as Address
const USDC = '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e' as Address
const BTC_B = '0x152b9d0fdc40c096757f570a51e494bd4b943e50' as Address

// Exact pools from quote_any.ts that returned 81 billion USDC
const POOL1 = '0x1ccc652b6a104b7e3adf7ff030b892e37097c111' as Address  // DODO (type 4)
const POOL2 = '0x4c4af8dbc524681930a27b2f1af5bcc8062e6fb7' as Address  // WOOFi (type 5)

const abi = JSON.parse(readFileSync('./contracts/Hayabusa.json', 'utf-8')).abi

async function main() {
    const client = createPublicClient({ chain: avalanche, transport: http(RPC) })

    console.log('=== Reproducing 81 Billion USDC Bug ===')
    console.log(`Hayabusa: ${HAYABUSA}`)
    console.log(`Pool 1: ${POOL1} (DODO type 4)`)
    console.log(`Pool 2: ${POOL2} (WOOFi type 5)`)
    console.log()

    const amountIn = 1_000_000n  // 1 USDC (6 decimals)

    // Get override for whale address
    const override = getOverride(USDC, WHALE, amountIn, HAYABUSA)
    console.log('Override slots:', Object.keys(override!['0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e'].stateDiff).length)

    // Convert to viem format
    const [addr, overrideData] = Object.entries(override!)[0]
    const stateDiff = Object.entries(overrideData.stateDiff).map(([slot, value]) => ({
        slot: slot as `0x${string}`,
        value: value as `0x${string}`
    }))
    const stateOverride = [{ address: addr as Address, stateDiff }]

    // Test with correct pool types: DODO=4, WOOFi=5
    console.log('\n=== Test: USDC -> BTC.b -> USDC with DODO(4), WOOFi(5) ===')
    try {
        const data = encodeFunctionData({
            abi,
            functionName: 'swap',
            args: [
                [POOL1, POOL2],
                [4, 5],  // DODO, WOOFi
                [USDC, BTC_B, USDC],
                amountIn
            ]
        })

        const result = await client.call({
            account: WHALE,
            to: HAYABUSA,
            data,
            stateOverride
        })

        const output = decodeFunctionResult({ abi, functionName: 'swap', data: result.data! }) as bigint
        console.log(`Result: ${output} (${Number(output) / 1e6} USDC)`)

        if (output > amountIn * 1000n) {
            console.log('🐛 BUG REPRODUCED! Output is WAY more than input!')
        } else if (output < amountIn) {
            console.log('✅ Correct behavior: output < input (fees taken)')
        }
    } catch (e: any) {
        console.log(`Reverted: ${e.message?.slice(0, 200)}`)
    }
}

main().catch(console.error)
