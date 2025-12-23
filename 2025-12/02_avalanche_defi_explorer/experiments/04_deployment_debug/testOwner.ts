import { createPublicClient, http } from 'viem'
import { avalanche } from 'viem/chains'

import { getRpcUrl } from '../../pkg/rpc.ts'
const RPC = getRpcUrl()

const address = process.argv[2] as `0x${string}`
if (!address) {
    console.error('Usage: node testOwner.ts <address>')
    process.exit(1)
}

const abi = [
    {
        "inputs": [],
        "name": "owner",
        "outputs": [{ "internalType": "address", "name": "", "type": "address" }],
        "stateMutability": "view",
        "type": "function"
    }
]

const transport = http(RPC)
const publicClient = createPublicClient({ chain: avalanche, transport })

console.log(`Calling owner() on ${address}...`)
try {
    const owner = await publicClient.readContract({
        address,
        abi,
        functionName: 'owner',
    })
    console.log(`Owner: ${owner}`)

    const code = await publicClient.getBytecode({ address })
    console.log(`Bytecode length: ${code ? (code.length - 2) / 2 : 0} bytes`)
} catch (err: any) {
    console.error('Call failed:')
    console.error(err.shortMessage ?? err.message ?? err)
}
