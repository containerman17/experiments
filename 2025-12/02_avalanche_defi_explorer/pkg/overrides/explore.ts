import { createPublicClient, http, parseAbi, keccak256, encodeAbiParameters, encodeFunctionData, padHex, type Address } from 'viem'
import { avalanche } from 'viem/chains'
import { getRpcUrl } from '../rpc.ts'
import TOKENS from './supported_tokens.json' with { type: 'json' }
import fs from 'fs'

const RPC = getRpcUrl()
const TEST_ADDRESS = '0x3062e40000000000000000000000000000000000' as Address
const SPENDER_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' as Address
const TEST_BALANCE = 123456789n

const erc20Abi = parseAbi([
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)'
])

// Known ERC-7201 bases
const ERC7201_BASES = [
    { name: 'OZ ERC20Upgradeable', base: '0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00' as const },
    { name: 'AUSD (Agora)', base: '0x455730fed596673e69db1907be2e521374ba893f1a04cc5f5dd931616cd6b700' as const },
]

const KNOWN_SLOTS = [0, 1, 2, 3, 4, 5, 7, 8, 9, 14, 51, 52, 56, 101, 203, 394]
const EXTENDED_SLOTS = Array.from({ length: 500 }, (_, i) => i)

function computeSlot(account: Address, slot: number): `0x${string}` {
    return keccak256(encodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }],
        [account, BigInt(slot)]
    ))
}

function computeErc7201Slot(account: Address, base: `0x${string}`): `0x${string}` {
    return keccak256(encodeAbiParameters(
        [{ type: 'address' }, { type: 'bytes32' }],
        [account, base]
    ))
}

function computeAllowanceSlot(owner: Address, spender: Address, baseSlot: number): `0x${string}` {
    const innerHash = keccak256(encodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }],
        [owner, BigInt(baseSlot)]
    ))
    return keccak256(encodeAbiParameters(
        [{ type: 'address' }, { type: 'bytes32' }],
        [spender, innerHash]
    ))
}

function computeErc7201AllowanceSlot(owner: Address, spender: Address, base: `0x${string}`): `0x${string}` {
    const innerHash = keccak256(encodeAbiParameters(
        [{ type: 'address' }, { type: 'bytes32' }],
        [owner, base]
    ))
    return keccak256(encodeAbiParameters(
        [{ type: 'address' }, { type: 'bytes32' }],
        [spender, innerHash]
    ))
}

async function tryBalanceOverride(
    client: ReturnType<typeof createPublicClient>,
    token: Address,
    storageSlot: `0x${string}`,
    value: bigint
): Promise<bigint> {
    const callData = encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [TEST_ADDRESS] })
    const valueHex = padHex(`0x${value.toString(16)}`, { size: 32 })

    try {
        const result = await client.request({
            method: 'eth_call',
            params: [
                { to: token, data: callData },
                'latest',
                { [token]: { stateDiff: { [storageSlot]: valueHex } } }
            ] as any
        })
        return BigInt(result as string)
    } catch (e) {
        return 0n
    }
}

async function tryAllowanceOverride(
    client: ReturnType<typeof createPublicClient>,
    token: Address,
    balanceSlot: `0x${string}`,
    allowanceSlot: `0x${string}`,
    value: bigint
): Promise<bigint> {
    const callData = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'allowance',
        args: [TEST_ADDRESS, SPENDER_ADDRESS]
    })
    const valueHex = padHex(`0x${value.toString(16)}`, { size: 32 })

    try {
        const result = await client.request({
            method: 'eth_call',
            params: [
                { to: token, data: callData },
                'latest',
                { [token]: { stateDiff: { [balanceSlot]: valueHex, [allowanceSlot]: valueHex } } }
            ] as any
        })
        return BigInt(result as string)
    } catch (e) {
        return 0n
    }
}

type BalanceConfig =
    | { type: 'slot', slot: number }
    | { type: 'erc7201', base: `0x${string}` }
    | { type: 'erc7201-packed', base: `0x${string}`, shift: number }

async function discoverBalance(
    client: ReturnType<typeof createPublicClient>,
    token: Address
): Promise<BalanceConfig | null> {
    console.log('🔍 Discovering balance slot...\n')

    // Try known slots first
    console.log('=== Trying known slots ===')
    for (const slot of KNOWN_SLOTS) {
        const storageSlot = computeSlot(TEST_ADDRESS, slot)
        const balance = await tryBalanceOverride(client, token, storageSlot, TEST_BALANCE)

        if (balance === TEST_BALANCE) {
            console.log(`✅ slot ${slot}: exact match`)
            return { type: 'slot', slot }
        }
    }

    // Try ERC-7201 bases
    console.log('\n=== Trying ERC-7201 bases ===')
    for (const { name, base } of ERC7201_BASES) {
        const storageSlot = computeErc7201Slot(TEST_ADDRESS, base)

        // Try without shift
        let balance = await tryBalanceOverride(client, token, storageSlot, TEST_BALANCE)
        if (balance === TEST_BALANCE) {
            console.log(`✅ ${name}: exact match`)
            return { type: 'erc7201', base }
        }

        // Try with shift 8 (packed bool|uint248)
        balance = await tryBalanceOverride(client, token, storageSlot, TEST_BALANCE << 8n)
        if (balance === TEST_BALANCE) {
            console.log(`✅ ${name} (shift 8): exact match`)
            return { type: 'erc7201-packed', base, shift: 8 }
        }
    }

    // Extended search
    console.log('\n=== Extended search (slots 0-499) ===')
    for (const slot of EXTENDED_SLOTS) {
        if (KNOWN_SLOTS.includes(slot)) continue

        const storageSlot = computeSlot(TEST_ADDRESS, slot)
        const balance = await tryBalanceOverride(client, token, storageSlot, TEST_BALANCE)

        if (balance === TEST_BALANCE) {
            console.log(`✅ slot ${slot}: exact match`)
            return { type: 'slot', slot }
        }
    }

    return null
}

async function discoverAllowance(
    client: ReturnType<typeof createPublicClient>,
    token: Address,
    balanceConfig: BalanceConfig
): Promise<string | null> {
    console.log('\n🔍 Discovering allowance slot...\n')

    if (balanceConfig.type === 'slot') {
        // Standard slot-based token
        const balanceSlot = balanceConfig.slot
        const balanceStorageSlot = computeSlot(TEST_ADDRESS, balanceSlot)

        console.log(`=== Testing allowance slots (offsets from balance slot ${balanceSlot}) ===`)
        const offsets = [+1, -1, +2, -2, +3, +4, +5, +10, -10]

        for (const offset of offsets) {
            const allowanceBaseSlot = balanceSlot + offset
            if (allowanceBaseSlot < 0) continue

            const allowanceStorageSlot = computeAllowanceSlot(TEST_ADDRESS, SPENDER_ADDRESS, allowanceBaseSlot)
            const result = await tryAllowanceOverride(client, token, balanceStorageSlot, allowanceStorageSlot, TEST_BALANCE)

            if (result === TEST_BALANCE) {
                if (offset === 1) {
                    console.log(`✅ allowance at slot ${allowanceBaseSlot} (default: slot+1)`)
                    return null // No need to specify allowanceSlot
                } else {
                    console.log(`✅ allowance at slot ${allowanceBaseSlot} (offset ${offset > 0 ? '+' : ''}${offset})`)
                    return `\"allowanceSlot\": ${allowanceBaseSlot}`
                }
            }
        }
    } else {
        // ERC-7201 token
        const base = balanceConfig.base
        const shift = balanceConfig.type === 'erc7201-packed' ? balanceConfig.shift : undefined
        const balanceStorageSlot = computeErc7201Slot(TEST_ADDRESS, base)

        console.log('=== Testing ERC-7201 allowance slot (same base) ===')
        const sameBaseAllowanceSlot = computeErc7201AllowanceSlot(TEST_ADDRESS, SPENDER_ADDRESS, base)
        const sameBaseResult = await tryAllowanceOverride(
            client, token, balanceStorageSlot, sameBaseAllowanceSlot,
            shift ? TEST_BALANCE << BigInt(shift) : TEST_BALANCE
        )

        if (sameBaseResult === TEST_BALANCE) {
            console.log(`✅ Using same base for allowance`)
            return null // Default behavior
        }

        console.log('\n=== Testing other ERC-7201 bases for allowance ===')
        for (const { name, base: testBase } of ERC7201_BASES) {
            if (testBase === base) continue

            const allowanceSlot = computeErc7201AllowanceSlot(TEST_ADDRESS, SPENDER_ADDRESS, testBase)
            const result = await tryAllowanceOverride(
                client, token, balanceStorageSlot, allowanceSlot,
                shift ? TEST_BALANCE << BigInt(shift) : TEST_BALANCE
            )

            if (result === TEST_BALANCE) {
                console.log(`✅ ${name}: exact match`)
                return `\"allowanceBase\": \"${testBase}\"`
            }
        }
    }

    return null
}

function formatConfig(balanceConfig: BalanceConfig, allowanceExtra: string | null): string {
    const parts: string[] = []

    if (balanceConfig.type === 'slot') {
        parts.push(`"slot": ${balanceConfig.slot}`)
    } else if (balanceConfig.type === 'erc7201') {
        parts.push(`"base": "${balanceConfig.base}"`)
    } else {
        parts.push(`"base": "${balanceConfig.base}"`)
        parts.push(`"shift": ${balanceConfig.shift}`)
    }

    if (allowanceExtra) {
        parts.push(allowanceExtra)
    }

    return `{ ${parts.join(', ')} }`
}

async function main() {
    const tokens = TOKENS as Record<string, any>

    // Find first null token
    const nullTokens = Object.entries(tokens).filter(([_, config]) => config === null)

    if (nullTokens.length === 0) {
        console.log('✅ No null tokens found! All tokens are configured.')
        return
    }

    const [token, _] = nullTokens[0]
    console.log(`\n${'='.repeat(80)}`)
    console.log(`🔬 Exploring token: ${token}`)
    console.log(`   (${nullTokens.length} null tokens remaining)`)
    console.log(`${'='.repeat(80)}\n`)

    const client = createPublicClient({ chain: avalanche, transport: http(RPC) })

    // Check if it's ERC20
    try {
        const balance = await client.readContract({
            address: token as Address,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [TEST_ADDRESS]
        })
        console.log(`Current balanceOf(test): ${balance}\n`)
    } catch (e) {
        console.error(`❌ Token doesn't support balanceOf: ${(e as Error).message}`)
        console.log(`\nRecommendation: Remove this token from supported_tokens.json`)
        return
    }

    // Discover balance
    const balanceConfig = await discoverBalance(client, token as Address)

    if (!balanceConfig) {
        console.log('\n❌ FAILED: Balance slot not found')
        console.log('\nRecommendation: Token uses non-standard storage. Keep as null.')
        return
    }

    // Discover allowance
    const allowanceExtra = await discoverAllowance(client, token as Address, balanceConfig)

    if (allowanceExtra === null && balanceConfig.type !== 'slot') {
        // ERC-7201 failed allowance
        console.log('\n⚠️  Balance works but allowance failed')
        console.log('\nRecommendation: Keep as null (29 other tokens have same issue)')
        return
    }

    const jsonConfig = formatConfig(balanceConfig, allowanceExtra)

    console.log('\n' + '='.repeat(80))
    console.log('✅ SUCCESS! Found complete configuration')
    console.log('='.repeat(80))
    console.log(`\nAdd to supported_tokens.json:`)
    console.log(`  "${token}": ${jsonConfig}`)
    console.log('')
}

main().catch(console.error)
