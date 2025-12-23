import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData, type Address, parseEther } from 'viem'
import { avalanche } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { getRpcUrl } from '../rpc.ts'
import { getOverride } from './getOverride.ts'

const RPC = getRpcUrl()
const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}`

if (!PRIVATE_KEY) {
    throw new Error('PRIVATE_KEY environment variable not set')
}

const TOKEN_ADDRESS = '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a' as Address
const WHALE_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' as Address
const TEST_AMOUNT = parseEther('1000') // 1000 tokens

const erc20Abi = parseAbi([
    'function approve(address spender, uint256 amount) returns (bool)',
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function transfer(address to, uint256 amount) returns (bool)'
])

async function main() {
    const account = privateKeyToAccount(PRIVATE_KEY)
    const publicClient = createPublicClient({
        chain: avalanche,
        transport: http(RPC)
    })
    const walletClient = createWalletClient({
        account,
        chain: avalanche,
        transport: http(RPC)
    })

    console.log('=== Testing Approval Overrides ===')
    console.log(`Token: ${TOKEN_ADDRESS}`)
    console.log(`Whale: ${WHALE_ADDRESS}`)
    console.log(`Spender: ${account.address}`)
    console.log(`Test Amount: ${TEST_AMOUNT}`)
    console.log(`RPC: ${RPC}\n`)

    // Step 1: Get override for this token
    console.log('Step 1: Getting state override...')
    const override = getOverride(TOKEN_ADDRESS, WHALE_ADDRESS, TEST_AMOUNT, account.address)

    if (!override) {
        console.log('❌ Token not configured for overrides')
        console.log('This token has null configuration in supported_tokens.json')
        console.log('You need to discover its storage slots first using study.ts')
        return
    }

    console.log('✅ Override generated:', JSON.stringify(override, null, 2))

    // Step 2: Test the override with eth_call
    console.log('\nStep 2: Testing override with eth_call...')

    const balanceCallData = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [WHALE_ADDRESS]
    })

    const allowanceCallData = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'allowance',
        args: [WHALE_ADDRESS, account.address]
    })

    try {
        const balanceResult = await publicClient.request({
            method: 'eth_call',
            params: [
                { to: TOKEN_ADDRESS, data: balanceCallData },
                'latest',
                override
            ] as any
        })
        console.log(`✅ Balance with override: ${BigInt(balanceResult as string)}`)
    } catch (e) {
        console.log(`❌ Balance check failed: ${(e as Error).message}`)
    }

    try {
        const allowanceResult = await publicClient.request({
            method: 'eth_call',
            params: [
                { to: TOKEN_ADDRESS, data: allowanceCallData },
                'latest',
                override
            ] as any
        })
        console.log(`✅ Allowance with override: ${BigInt(allowanceResult as string)}`)
    } catch (e) {
        console.log(`❌ Allowance check failed: ${(e as Error).message}`)
    }

    // Step 3: Create a transaction and debug it with state tracer
    console.log('\nStep 3: Creating transaction and debugging with state tracer...')

    const approveCallData = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [account.address, parseEther('100')]
    })

    const tx = {
        from: account.address,
        to: TOKEN_ADDRESS,
        data: approveCallData,
        gas: '0x186a0' // 100000 in hex
    }

    console.log('Transaction:', tx)

    // Use debug_traceCall with prestateTracer to see state changes
    console.log('\nStep 4: Tracing with prestateTracer...')
    try {
        const traceResult = await publicClient.request({
            method: 'debug_traceCall' as any,
            params: [
                tx,
                'latest',
                {
                    tracer: 'prestateTracer',
                    tracerConfig: {
                        diffMode: true
                    }
                }
            ] as any
        })

        console.log('\n=== STATE TRACER RESULTS (prestateTracer) ===')
        console.log(JSON.stringify(traceResult, null, 2))
    } catch (e) {
        console.log(`❌ prestateTracer failed: ${(e as Error).message}`)
    }

    // Also try with callTracer to see the execution trace
    console.log('\nStep 5: Tracing with callTracer...')
    try {
        const callTrace = await publicClient.request({
            method: 'debug_traceCall' as any,
            params: [
                tx,
                'latest',
                {
                    tracer: 'callTracer',
                    tracerConfig: {
                        onlyTopCall: false
                    }
                }
            ] as any
        })

        console.log('\n=== CALL TRACER RESULTS ===')
        console.log(JSON.stringify(callTrace, null, 2))
    } catch (e) {
        console.log(`❌ callTracer failed: ${(e as Error).message}`)
    }

    // Step 6: Try with state override applied
    console.log('\nStep 6: Tracing with override and prestateTracer...')
    try {
        const traceWithOverride = await publicClient.request({
            method: 'debug_traceCall' as any,
            params: [
                {
                    ...tx,
                    from: WHALE_ADDRESS  // Call from whale address
                },
                'latest',
                {
                    tracer: 'prestateTracer',
                    tracerConfig: {
                        diffMode: true
                    },
                    stateOverrides: override
                }
            ] as any
        })

        console.log('\n=== STATE TRACER WITH OVERRIDE ===')
        console.log(JSON.stringify(traceWithOverride, null, 2))
    } catch (e) {
        console.log(`❌ Trace with override failed: ${(e as Error).message}`)
    }

    console.log('\n=== Test Complete ===')
}

main().catch(console.error)
