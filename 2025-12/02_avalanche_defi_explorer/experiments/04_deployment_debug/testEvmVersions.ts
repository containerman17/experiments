import { readFileSync } from 'fs'
import solc from 'solc'
import { createPublicClient, createWalletClient, http } from 'viem'
import { avalanche } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import path from 'path'
import { fileURLToPath } from 'url'
import { getRpcUrl } from '../../pkg/rpc.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const RPC = getRpcUrl()
const privateKey = process.env.PRIVATE_KEY

if (!privateKey) {
    console.error('Set PRIVATE_KEY env var in .env')
    process.exit(1)
}

const sourcePath = path.join(__dirname, '../../contracts/Hayabusa.sol')
const source = readFileSync(sourcePath, 'utf-8')

const deployWithVersion = async (evmVersion: string) => {
    console.log(`\n--- Deploying with evmVersion: ${evmVersion} ---`)
    const input = {
        language: 'Solidity',
        sources: { 'Hayabusa.sol': { content: source } },
        settings: {
            evmVersion: evmVersion,
            optimizer: { enabled: true, runs: 200 },
            outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } }
        }
    }
    const output = JSON.parse(solc.compile(JSON.stringify(input)))
    if (output.errors?.some((e: any) => e.severity === 'error')) {
        console.error(`Compilation errors for ${evmVersion}:`, output.errors)
        return
    }
    const contract = output.contracts['Hayabusa.sol']['Hayabusa']
    const abi = contract.abi
    const bytecode = `0x${contract.evm.bytecode.object}` as `0x${string}`

    const transport = http(RPC)
    const publicClient = createPublicClient({ chain: avalanche, transport })
    const account = privateKeyToAccount(privateKey as `0x${string}`)
    const walletClient = createWalletClient({ account, chain: avalanche, transport })

    console.log(`Deploying from ${account.address}...`)

    try {
        const hash = await walletClient.deployContract({ abi, bytecode, args: [] })
        console.log(`TX: ${hash}`)

        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        console.log(`✅ Deployed at: ${receipt.contractAddress}`)

        const code = await publicClient.getBytecode({ address: receipt.contractAddress! })
        console.log(`Bytecode length: ${code ? (code.length - 2) / 2 : 0} bytes`)

        if (code && code.length > 2) {
            const owner = await publicClient.readContract({
                address: receipt.contractAddress!,
                abi,
                functionName: 'owner',
            })
            console.log(`Owner: ${owner}`)
        } else {
            console.log('🔴 NO CODE RETURNED!')
        }
    } catch (err: any) {
        console.error('Deployment or call failed:')
        console.error(err.shortMessage ?? err.message ?? err)
    }
}

await deployWithVersion('cancun')
await deployWithVersion('shanghai')
await deployWithVersion('paris')
