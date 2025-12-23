import { createPublicClient, http } from 'viem'
import { avalanche } from 'viem/chains'

import { getRpcUrl } from '../../pkg/rpc.ts'
const RPC = getRpcUrl()

const address = process.argv[2] as `0x${string}`
if (!address) {
    console.error('Usage: node checkCode.ts <address>')
    process.exit(1)
}

const transport = http(RPC)
const publicClient = createPublicClient({ chain: avalanche, transport })

console.log(`Checking ${address}...`)
const code = await publicClient.getBytecode({ address })
console.log(`Bytecode length: ${code ? (code.length - 2) / 2 : 0} bytes`)
if (code) {
    console.log(`Bytecode (first 64 hex): ${code.slice(0, 66)}`)
}
