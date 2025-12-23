import { createPublicClient, http, parseAbi, keccak256, encodeAbiParameters, encodeFunctionData, padHex, type Address } from 'viem'
import { avalanche } from 'viem/chains'
import { getRpcUrl } from '../rpc.ts'

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

function computeBalanceSlot(account: Address, slot: number): `0x${string}` {
    return keccak256(encodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }],
        [account, BigInt(slot)]
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

function computeErc7201BalanceSlot(account: Address, base: `0x${string}`): `0x${string}` {
    return keccak256(encodeAbiParameters(
        [{ type: 'address' }, { type: 'bytes32' }],
        [account, base]
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

async function tryAllowanceOverride(
    client: ReturnType<typeof createPublicClient>,
    token: Address,
    balanceSlot: `0x${string}`,
    allowanceSlot: `0x${string}`,
    value: bigint,
    shift?: number
): Promise<bigint> {
    const callData = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'allowance',
        args: [TEST_ADDRESS, SPENDER_ADDRESS]
    })
    const valueWithShift = shift !== undefined ? value << BigInt(shift) : value
    const valueHex = padHex(`0x${valueWithShift.toString(16)}`, { size: 32 })

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

async function main() {
    const args = process.argv.slice(2)
    const token = args[0]?.toLowerCase() as Address
    const balanceSlotArg = args[1]

    if (!token || !token.startsWith('0x')) {
        console.error('Usage: node studyAllowance.ts <token_address> <balance_slot_or_base> [shift]')
        console.error('  balance_slot_or_base: number (e.g., 9) for standard slot, or 0x... for ERC-7201 base')
        console.error('  shift: optional shift value (e.g., 8) for packed tokens')
        process.exit(1)
    }

    if (!balanceSlotArg) {
        console.error('Error: must provide balance slot or ERC-7201 base')
        process.exit(1)
    }

    const shift = args[2] ? parseInt(args[2]) : undefined
    const client = createPublicClient({ chain: avalanche, transport: http(RPC) })

    console.log(`Studying allowance slot for token: ${token}`)
    console.log(`Balance configuration: ${balanceSlotArg}${shift !== undefined ? ` (shift ${shift})` : ''}`)
    console.log(`Test address: ${TEST_ADDRESS}`)
    console.log(`Spender: ${SPENDER_ADDRESS}`)
    console.log(`Test balance: ${TEST_BALANCE}\n`)

    const isErc7201 = balanceSlotArg.startsWith('0x')
    const found: Array<{ config: string; allowance: bigint }> = []

    if (isErc7201) {
        // ERC-7201 token
        const base = balanceSlotArg as `0x${string}`
        const balanceSlot = computeErc7201BalanceSlot(TEST_ADDRESS, base)

        console.log('=== Testing ERC-7201 allowance slot (same base) ===')
        const sameBaseAllowanceSlot = computeErc7201AllowanceSlot(TEST_ADDRESS, SPENDER_ADDRESS, base)
        const sameBaseResult = await tryAllowanceOverride(client, token, balanceSlot, sameBaseAllowanceSlot, TEST_BALANCE, shift)

        if (sameBaseResult === TEST_BALANCE) {
            console.log(`✅ Using same base for allowance: exact match`)
            found.push({ config: `Same as balance base`, allowance: sameBaseResult })
        } else {
            console.log(`❌ Using same base for allowance: ${sameBaseResult}`)
        }

        // Try other known bases
        console.log('\n=== Testing other ERC-7201 bases for allowance ===')
        for (const { name, base: testBase } of ERC7201_BASES) {
            if (testBase === base) continue

            const allowanceSlot = computeErc7201AllowanceSlot(TEST_ADDRESS, SPENDER_ADDRESS, testBase)
            const result = await tryAllowanceOverride(client, token, balanceSlot, allowanceSlot, TEST_BALANCE, shift)

            if (result === TEST_BALANCE) {
                console.log(`✅ ${name}: exact match (base=${testBase})`)
                found.push({ config: `{ "allowanceBase": "${testBase}" }`, allowance: result })
            }
        }
    } else {
        // Standard slot-based token
        const balanceSlot = parseInt(balanceSlotArg)
        const balanceStorageSlot = computeBalanceSlot(TEST_ADDRESS, balanceSlot)

        console.log(`=== Testing allowance slots (offsets from balance slot ${balanceSlot}) ===`)

        // Try common patterns
        const offsets = [-1, +1, +2, -2, +3, +4, +5, +10, -10]
        for (const offset of offsets) {
            const allowanceBaseSlot = balanceSlot + offset
            if (allowanceBaseSlot < 0) continue

            const allowanceStorageSlot = computeAllowanceSlot(TEST_ADDRESS, SPENDER_ADDRESS, allowanceBaseSlot)
            const result = await tryAllowanceOverride(client, token, balanceStorageSlot, allowanceStorageSlot, TEST_BALANCE, shift)

            if (result === TEST_BALANCE) {
                console.log(`✅ allowance at slot ${allowanceBaseSlot} (offset ${offset > 0 ? '+' : ''}${offset}): exact match`)
                if (offset !== 1) {
                    found.push({ config: `{ "slot": ${balanceSlot}, "allowanceSlot": ${allowanceBaseSlot} }`, allowance: result })
                } else {
                    found.push({ config: `Default (slot+1)`, allowance: result })
                }
            }
        }
    }

    // Summary
    console.log('\n=== RESULTS ===')
    if (found.length === 0) {
        console.log('❌ No matching allowance slot found.')
    } else {
        console.log('Found working allowance configurations:')
        for (const f of found) {
            console.log(`  ${f.config}`)
        }
        if (found[0].config.startsWith('{')) {
            console.log(`\nUpdate in supported_tokens.json:`)
            console.log(`  "${token}": ${found[0].config}`)
        }
    }
}

main().catch(console.error)
