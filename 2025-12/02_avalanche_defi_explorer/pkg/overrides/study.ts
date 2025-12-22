import { createPublicClient, http, parseAbi, keccak256, encodeAbiParameters, encodeFunctionData, padHex, type Address } from 'viem'
import { avalanche } from 'viem/chains'

const RPC = process.env.RPC || 'http://localhost:9650/ext/bc/C/rpc'
const TEST_ADDRESS = '0x3062e40000000000000000000000000000000000' as Address
const TEST_BALANCE = 123456789n

const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)'])

// Known ERC-7201 bases
const ERC7201_BASES = [
    { name: 'OZ ERC20Upgradeable', base: '0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00' as const },
    { name: 'AUSD (Agora)', base: '0x455730fed596673e69db1907be2e521374ba893f1a04cc5f5dd931616cd6b700' as const },
]

// Known mapping slots we've seen
const KNOWN_SLOTS = [0, 1, 2, 3, 4, 5, 7, 8, 9, 14, 51, 52, 56, 101, 203, 394]

// Extended search range (increased to 500 for deep inheritance chains like LayerZero OFT)
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

async function tryOverride(
    client: ReturnType<typeof createPublicClient>,
    token: Address,
    storageSlot: `0x${string}`,
    value: bigint
): Promise<bigint> {
    const callData = encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [TEST_ADDRESS] })
    const valueHex = padHex(`0x${value.toString(16)}`, { size: 32 })

    const result = await client.request({
        method: 'eth_call',
        params: [
            { to: token, data: callData },
            'latest',
            { [token]: { stateDiff: { [storageSlot]: valueHex } } }
        ] as any
    })

    return BigInt(result as string)
}

async function main() {
    const token = process.argv[2]?.toLowerCase() as Address
    if (!token || !token.startsWith('0x')) {
        console.error('Usage: node study.ts <token_address>')
        process.exit(1)
    }

    const client = createPublicClient({ chain: avalanche, transport: http(RPC) })

    console.log(`Studying token: ${token}`)
    console.log(`Test address: ${TEST_ADDRESS}`)
    console.log(`Test balance: ${TEST_BALANCE}`)
    console.log(`RPC: ${RPC}\n`)

    // Check if it's ERC20
    try {
        const balance = await client.readContract({
            address: token,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [TEST_ADDRESS]
        })
        console.log(`Current balanceOf(test): ${balance}\n`)
    } catch (e) {
        console.error(`Token doesn't support balanceOf: ${(e as Error).message}`)
        process.exit(1)
    }

    const found: Array<{ type: string; config: string; balance: bigint }> = []

    // Try known slots first
    console.log('=== Trying known slots ===')
    for (const slot of KNOWN_SLOTS) {
        const storageSlot = computeSlot(TEST_ADDRESS, slot)
        const balance = await tryOverride(client, token, storageSlot, TEST_BALANCE)

        if (balance === TEST_BALANCE) {
            console.log(`✅ slot ${slot}: exact match`)
            found.push({ type: 'slot', config: `{ "slot": ${slot} }`, balance })
        } else if (balance > 0n && balance !== TEST_BALANCE) {
            const ratio = Number(balance) / Number(TEST_BALANCE)
            if (ratio > 0.5 && ratio < 10) {
                console.log(`⚠️  slot ${slot}: rebasing token (ratio=${ratio.toFixed(4)}, balance=${balance})`)
                found.push({ type: 'slot (rebasing)', config: `{ "slot": ${slot} }`, balance })
            }
        }
    }

    // Try ERC-7201 bases
    console.log('\n=== Trying ERC-7201 bases ===')
    for (const { name, base } of ERC7201_BASES) {
        const storageSlot = computeErc7201Slot(TEST_ADDRESS, base)

        // Try without shift
        let balance = await tryOverride(client, token, storageSlot, TEST_BALANCE)
        if (balance === TEST_BALANCE) {
            console.log(`✅ ${name}: exact match`)
            found.push({ type: 'erc7201', config: `{ "base": "${base}" }`, balance })
            continue
        }

        // Try with shift 8 (packed bool|uint248)
        balance = await tryOverride(client, token, storageSlot, TEST_BALANCE << 8n)
        if (balance === TEST_BALANCE) {
            console.log(`✅ ${name} (shift 8): exact match`)
            found.push({ type: 'erc7201 packed', config: `{ "base": "${base}", "shift": 8 }`, balance })
        }
    }

    // If nothing found, do extended search
    if (found.length === 0) {
        console.log('\n=== Extended search (slots 0-499) ===')
        for (const slot of EXTENDED_SLOTS) {
            if (KNOWN_SLOTS.includes(slot)) continue

            const storageSlot = computeSlot(TEST_ADDRESS, slot)
            const balance = await tryOverride(client, token, storageSlot, TEST_BALANCE)

            if (balance === TEST_BALANCE) {
                console.log(`✅ slot ${slot}: exact match`)
                found.push({ type: 'slot', config: `{ "slot": ${slot} }`, balance })
                break // Found it
            } else if (balance > 0n && balance !== TEST_BALANCE) {
                const ratio = Number(balance) / Number(TEST_BALANCE)
                if (ratio > 0.5 && ratio < 10) {
                    console.log(`⚠️  slot ${slot}: rebasing token (ratio=${ratio.toFixed(4)}, balance=${balance})`)
                    found.push({ type: 'slot (rebasing)', config: `{ "slot": ${slot} }`, balance })
                    break
                }
            }
        }
    }

    // Summary
    console.log('\n=== RESULTS ===')
    if (found.length === 0) {
        console.log('❌ No matching slot found. May need manual investigation via debug_traceTransaction.')
    } else {
        console.log('Found working configurations:')
        for (const f of found) {
            console.log(`  ${f.type}: ${f.config}`)
        }
        console.log(`\nAdd to supported_tokens.json:`)
        console.log(`  "${token}": ${found[0].config}`)
    }
}

main().catch(console.error)

