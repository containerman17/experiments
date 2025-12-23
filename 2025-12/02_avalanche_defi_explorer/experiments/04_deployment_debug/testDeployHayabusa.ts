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

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

const sourcePath = path.join(__dirname, '../../contracts/Hayabusa.sol')
const source = readFileSync(sourcePath, 'utf-8')

console.log('Compiling Hayabusa.sol...')
const input = {
    language: 'Solidity',
    sources: { 'Hayabusa.sol': { content: source } },
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
const contract = output.contracts['Hayabusa.sol']['Hayabusa']
const abi = contract.abi
const bytecode = `0x${contract.evm.bytecode.object}` as `0x${string}`

const transport = http(RPC)
const publicClient = createPublicClient({ chain: avalanche, transport })
const account = privateKeyToAccount(privateKey as `0x${string}`)
const walletClient = createWalletClient({ account, chain: avalanche, transport })

console.log(`Deploying Hayabusa from ${account.address}...`)

const hash = await walletClient.deployContract({ abi, bytecode, args: [] })
console.log(`TX: ${hash}`)

// Wait with retries
const maxAttempts = 5
let receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>> | undefined
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
        receipt = await publicClient.waitForTransactionReceipt({ hash })
        break
    } catch (err: any) {
        const msg = String(err?.shortMessage ?? err?.message ?? err)
        const isReceiptNotFound =
            err?.name === 'TransactionReceiptNotFoundError' ||
            msg.includes('TransactionReceiptNotFoundError') ||
            msg.includes('could not be found') ||
            msg.includes('may not be processed')

        if (!isReceiptNotFound || attempt === maxAttempts) throw err

        const delayMs = 2000 * attempt
        console.warn(`Receipt not found yet (attempt ${attempt}/${maxAttempts}). Retrying in ${delayMs}ms...`)
        await sleep(delayMs)
    }
}

if (!receipt) {
    throw new Error(`Failed to fetch transaction receipt after ${maxAttempts} attempts: ${hash}`)
}

console.log(`✅ Hayabusa deployed at: ${receipt.contractAddress}`)

// Immediate test call
console.log(`\nCalling owner() on ${receipt.contractAddress}...`)
try {
    const owner = await publicClient.readContract({
        address: receipt.contractAddress!,
        abi,
        functionName: 'owner',
    })
    console.log(`Owner: ${owner}`)

    const code = await publicClient.getBytecode({ address: receipt.contractAddress! })
    console.log(`Bytecode length: ${code ? (code.length - 2) / 2 : 0} bytes`)
} catch (err: any) {
    console.error('Call failed:')
    console.error(err.shortMessage ?? err.message ?? err)
}
