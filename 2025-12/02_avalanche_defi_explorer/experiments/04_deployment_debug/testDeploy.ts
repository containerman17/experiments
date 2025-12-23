import { readFileSync } from 'fs'
import solc from 'solc'
import { createPublicClient, createWalletClient, http } from 'viem'
import { avalanche } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { config } from "dotenv"
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.join(__dirname, '../../.env') })

const RPC = process.env.RPC!
const privateKey = process.env.PRIVATE_KEY

if (!privateKey) {
    console.error('Set PRIVATE_KEY env var in .env')
    process.exit(1)
}

const sourcePath = path.join(__dirname, '../../contracts/HelloWorld.sol')
const source = readFileSync(sourcePath, 'utf-8')

console.log('Compiling HelloWorld.sol...')
const input = {
    language: 'Solidity',
    sources: { 'HelloWorld.sol': { content: source } },
    settings: {
        evmVersion: 'paris',
        optimizer: { enabled: true, runs: 200 },
        outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } }
    }
}
const output = JSON.parse(solc.compile(JSON.stringify(input)))
if (output.errors?.some((e: any) => e.severity === 'error')) {
    console.error(output.errors)
    process.exit(1)
}
const contract = output.contracts['HelloWorld.sol']['HelloWorld']
const abi = contract.abi
const bytecode = `0x${contract.evm.bytecode.object}` as `0x${string}`

const transport = http(RPC)
const publicClient = createPublicClient({ chain: avalanche, transport })
const account = privateKeyToAccount(privateKey as `0x${string}`)
const walletClient = createWalletClient({ account, chain: avalanche, transport })

console.log(`Deploying from ${account.address}...`)

const hash = await walletClient.deployContract({ abi, bytecode, args: [] })
console.log(`TX: ${hash}`)

const receipt = await publicClient.waitForTransactionReceipt({ hash })
console.log(`✅ HelloWorld deployed at: ${receipt.contractAddress}`)
console.log(`\nTo test call, run:\nnode ./testCall.ts ${receipt.contractAddress}`)
