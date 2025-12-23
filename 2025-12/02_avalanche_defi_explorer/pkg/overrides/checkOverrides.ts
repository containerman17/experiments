import { createPublicClient, http, parseAbi, encodeFunctionData, type Address } from 'viem'
import { avalanche } from 'viem/chains'
import { getOverride, getSupportedTokens } from './getOverride.ts'
import { getRpcUrl } from '../rpc.ts'

const RPC = getRpcUrl()
const TEST_ADDRESS = '0x3062e40000000000000000000000000000000000' as Address
const SPENDER_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' as Address  // Test spender (whale address)
const TEST_BALANCE = 123456789n

const erc20Abi = parseAbi([
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)'
])

async function main() {
    const client = createPublicClient({ chain: avalanche, transport: http(RPC) })

    // Support optional token address argument
    const targetToken = process.argv[2]?.toLowerCase() as Address | undefined

    let tokens = getSupportedTokens()
    if (targetToken) {
        if (!tokens.map(t => t.toLowerCase()).includes(targetToken)) {
            console.error(`Error: Token ${targetToken} not found in supported_tokens.json`)
            process.exit(1)
        }
        tokens = [targetToken as Address]
        console.log(`Testing single token: ${targetToken}\n`)
    }

    const configured = tokens.filter(t => getOverride(t, TEST_ADDRESS, TEST_BALANCE, SPENDER_ADDRESS) !== null)
    const unconfigured = tokens.length - configured.length

    console.log(`Checking ${configured.length} configured tokens (${unconfigured} pending)...`)
    console.log(`RPC: ${RPC}`)
    console.log(`Test address: ${TEST_ADDRESS}`)
    console.log(`Spender address: ${SPENDER_ADDRESS}`)
    console.log(`Test balance: ${TEST_BALANCE}\n`)

    const failed: string[] = []
    const passed: string[] = []

    for (const token of configured) {
        const override = getOverride(token, TEST_ADDRESS, TEST_BALANCE, SPENDER_ADDRESS)
        if (!override) continue  // skip null (shouldn't happen after filter)

        let balanceOk = false
        let allowanceOk = false
        let errorMsg = ''

        // Check 1: Balance
        try {
            const balanceCallData = encodeFunctionData({
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [TEST_ADDRESS]
            })

            const balanceResult = await client.request({
                method: 'eth_call',
                params: [
                    { to: token, data: balanceCallData },
                    'latest',
                    override
                ] as any
            })

            const balance = BigInt(balanceResult as string)
            balanceOk = balance >= TEST_BALANCE

            if (!balanceOk) {
                errorMsg = `balance=${balance}, expected>=${TEST_BALANCE}`
            }
        } catch (e) {
            errorMsg = `balance error: ${(e as Error).message}`
        }

        // Check 2: Allowance
        try {
            const allowanceCallData = encodeFunctionData({
                abi: erc20Abi,
                functionName: 'allowance',
                args: [TEST_ADDRESS, SPENDER_ADDRESS]
            })

            const allowanceResult = await client.request({
                method: 'eth_call',
                params: [
                    { to: token, data: allowanceCallData },
                    'latest',
                    override
                ] as any
            })

            const allowance = BigInt(allowanceResult as string)
            allowanceOk = allowance >= TEST_BALANCE

            if (!allowanceOk) {
                errorMsg += (errorMsg ? ', ' : '') + `allowance=${allowance}, expected>=${TEST_BALANCE}`
            }
        } catch (e) {
            errorMsg += (errorMsg ? ', ' : '') + `allowance error: ${(e as Error).message}`
        }

        // Report results
        if (balanceOk && allowanceOk) {
            console.log(`✅ ${token}`)
            passed.push(token)
        } else {
            console.log(`❌ ${token} - ${errorMsg}`)
            failed.push(token)
        }
    }

    console.log(`\n=== SUMMARY ===`)
    console.log(`Passed: ${passed.length}/${configured.length}`)
    console.log(`Failed: ${failed.length}/${configured.length}`)
    console.log(`Pending (null): ${unconfigured}`)

    if (failed.length > 0) {
        console.log(`\nFailed tokens:`)
        for (const t of failed) {
            console.log(`  - ${t}`)
        }
        process.exit(1)
    }
}

main().catch(console.error)

