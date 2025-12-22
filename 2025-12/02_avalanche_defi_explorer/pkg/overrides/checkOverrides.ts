import { createPublicClient, http, parseAbi, encodeFunctionData, type Address } from 'viem'
import { avalanche } from 'viem/chains'
import { getOverride, getSupportedTokens } from './getOverride.ts'

const RPC = process.env.RPC || 'http://localhost:9650/ext/bc/C/rpc'
const TEST_ADDRESS = '0x3062e40000000000000000000000000000000000' as Address
const TEST_BALANCE = 123456789n

const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)'])

async function main() {
    const client = createPublicClient({ chain: avalanche, transport: http(RPC) })
    const tokens = getSupportedTokens()

    const configured = tokens.filter(t => getOverride(t, TEST_ADDRESS, TEST_BALANCE) !== null)
    const unconfigured = tokens.length - configured.length

    console.log(`Checking ${configured.length} configured tokens (${unconfigured} pending)...`)
    console.log(`RPC: ${RPC}`)
    console.log(`Test address: ${TEST_ADDRESS}`)
    console.log(`Test balance: ${TEST_BALANCE}\n`)

    const failed: string[] = []
    const passed: string[] = []

    for (const token of configured) {
        const override = getOverride(token, TEST_ADDRESS, TEST_BALANCE)
        if (!override) continue  // skip null (shouldn't happen after filter)

        try {
            const callData = encodeFunctionData({
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [TEST_ADDRESS]
            })

            const result = await client.request({
                method: 'eth_call',
                params: [
                    { to: token, data: callData },
                    'latest',
                    override
                ] as any
            })

            const balance = BigInt(result as string)

            if (balance >= TEST_BALANCE) {
                console.log(`✅ ${token} - balance=${balance}`)
                passed.push(token)
            } else {
                console.log(`❌ ${token} - balance=${balance}, expected>=${TEST_BALANCE}`)
                failed.push(token)
            }
        } catch (e) {
            console.log(`❌ ${token} - error: ${(e as Error).message}`)
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

