import { createPublicClient, http } from 'viem'
import { avalanche } from 'viem/chains'
import { config } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.join(__dirname, '../../.env') })

const RPC = process.env.RPC!

const address = process.argv[2] as `0x${string}`
if (!address) {
    console.error('Usage: node testCall.ts <address>')
    process.exit(1)
}

const abi = [
    {
        "inputs": [],
        "name": "greet",
        "outputs": [{ "internalType": "string", "name": "", "type": "string" }],
        "stateMutability": "view",
        "type": "function"
    },
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

console.log(`Calling greet() on ${address}...`)
try {
    const greeting = await publicClient.readContract({
        address,
        abi,
        functionName: 'greet',
    })
    console.log(`Greeting: ${greeting}`)

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
