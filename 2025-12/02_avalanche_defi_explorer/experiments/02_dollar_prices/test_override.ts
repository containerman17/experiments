import { createPublicClient, http, parseUnits, formatUnits, type Address, keccak256, encodeAbiParameters, padHex } from 'viem'
import { avalanche } from 'viem/chains'
import 'dotenv/config'

const RPC_URL = 'http://167.235.8.126:9650/ext/bc/C/rpc'
const USDC = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E' as Address
const ROUTER = process.env.ROUTER_CONTRACT! as Address

const client = createPublicClient({
    chain: avalanche,
    transport: http(RPC_URL)
})

async function testOverride() {
    const amount = parseUnits('1', 6)
    const slot = 9

    const storageSlot = keccak256(
        encodeAbiParameters(
            [{ type: 'address' }, { type: 'uint256' }],
            [ROUTER, BigInt(slot)]
        )
    )
    const storageValue = padHex(`0x${amount.toString(16)}`, { size: 32 })

    console.log(`Testing override for ${ROUTER} on ${USDC}`)
    console.log(`Slot: ${slot}, Storage Slot: ${storageSlot}, Value: ${storageValue}`)

    const balanceBefore = await client.readContract({
        address: USDC,
        abi: [{ inputs: [{ name: 'account', type: 'address' }], name: 'balanceOf', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' }],
        functionName: 'balanceOf',
        args: [ROUTER]
    })

    console.log(`Balance before: ${formatUnits(balanceBefore, 6)} USDC`)

    const balanceWithOverride = await client.readContract({
        address: USDC,
        abi: [{ inputs: [{ name: 'account', type: 'address' }], name: 'balanceOf', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' }],
        functionName: 'balanceOf',
        args: [ROUTER],
        stateOverride: [{
            address: USDC,
            stateDiff: [{ slot: storageSlot, value: storageValue }]
        }]
    })

    console.log(`Balance with override: ${formatUnits(balanceWithOverride, 6)} USDC`)

    if (balanceWithOverride === amount) {
        console.log('✅ Override SUCCESS')
    } else {
        console.log('❌ Override FAILED')
    }
}

testOverride().catch(console.error)
