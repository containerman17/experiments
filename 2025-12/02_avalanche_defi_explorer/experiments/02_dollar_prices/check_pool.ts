import { createPublicClient, http, type Address } from 'viem'
import { avalanche } from 'viem/chains'

const RPC_URL = 'http://167.235.8.126:9650/ext/bc/C/rpc'
const pool = '0x864d4e5ee7318e97483db7eb0912e09f161516ea' as Address

const client = createPublicClient({
    chain: avalanche,
    transport: http(RPC_URL)
})

async function checkPool() {
    const [tokenX, tokenY] = await Promise.all([
        client.readContract({
            address: pool,
            abi: [{ inputs: [], name: 'getTokenX', outputs: [{ type: 'address' }], stateMutability: 'view', type: 'function' }],
            functionName: 'getTokenX'
        }),
        client.readContract({
            address: pool,
            abi: [{ inputs: [], name: 'getTokenY', outputs: [{ type: 'address' }], stateMutability: 'view', type: 'function' }],
            functionName: 'getTokenY'
        })
    ])

    console.log(`Pool: ${pool}`)
    console.log(`Token X: ${tokenX}`)
    console.log(`Token Y: ${tokenY}`)
}

checkPool().catch(console.error)
