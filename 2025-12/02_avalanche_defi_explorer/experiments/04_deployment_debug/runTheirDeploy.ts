import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs'
import solc from 'solc'
import { createPublicClient, createWalletClient, http } from 'viem'
import { avalanche } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { config } from "dotenv"

config()
import { getRpcUrl } from '../../pkg/rpc.ts'
const RPC = getRpcUrl()

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}


const dir = import.meta.dirname
const envPath = `${dir}/../.env`
const envContent = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : ''

// Commented out to allow multiple runs
// if (/^ROUTER_CONTRACT=/m.test(envContent)) {
//     console.error('💀 ROUTER_CONTRACT already exists in .env. Delete it first.')
//     process.exit(1)
// }

const privateKey = process.env.PRIVATE_KEY
if (!privateKey) {
    console.error('Set PRIVATE_KEY env var')
    process.exit(1)
}

// Compile
console.log('Compiling Hayabusa.sol...')
const source = readFileSync(`${dir}/../contracts/Hayabusa.sol`, 'utf-8')
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

// Save ABI
writeFileSync(`${dir}/../contracts/Hayabusa.json`, JSON.stringify({ abi, bytecode }, null, 2))
console.log('Compiled -> contracts/Hayabusa.json')

// Deploy
const transport = http(RPC)
const publicClient = createPublicClient({ chain: avalanche, transport })
const account = privateKeyToAccount(privateKey as `0x${string}`)
const walletClient = createWalletClient({ account, chain: avalanche, transport })

console.log(`\nDeploying from ${account.address}...`)

const hash = await walletClient.deployContract({ abi, bytecode, args: [] })
console.log(`TX: ${hash}`)

const maxAttempts = 3
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

        const delayMs = 1500 * attempt
        console.warn(`Receipt not found yet (attempt ${attempt}/${maxAttempts}). Retrying in ${delayMs}ms...`)
        await sleep(delayMs)
    }
}

if (!receipt) {
    throw new Error(`Failed to fetch transaction receipt after ${maxAttempts} attempts: ${hash}`)
}
const routerAddress = receipt.contractAddress!

console.log(`\n✅ Router deployed at: ${routerAddress}`)

// Update .env
const newLine = envContent.endsWith('\n') || envContent === '' ? '' : '\n'
appendFileSync(envPath, `${newLine}ROUTER_CONTRACT=${routerAddress}\n`)
console.log(`\n📝 Added ROUTER_CONTRACT=${routerAddress} to .env`)


