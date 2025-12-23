import { keccak256, encodeAbiParameters, padHex, type Address } from 'viem'
import TOKENS from './supported_tokens.json' with { type: 'json' }

type TokenOverride =
    | { slot: number; allowanceSlot?: number }              // mapping(address=>uint) at slot N, allowance at slot M (default: N+1)
    | { base: `0x${string}`; allowanceBase?: `0x${string}` } // ERC-7201: keccak256(encode(addr, base))
    | { base: `0x${string}`; shift: number; allowanceBase?: `0x${string}` }    // ERC-7201 packed: value << shift

const tokens = TOKENS as Record<string, TokenOverride | null>

function computeStorageSlot(account: Address, override: TokenOverride): `0x${string}` {
    if ('slot' in override && !('base' in override)) {
        // Standard mapping(address => uint256) at slot N
        return keccak256(
            encodeAbiParameters(
                [{ type: 'address' }, { type: 'uint256' }],
                [account, BigInt(override.slot)]
            )
        )
    }
    // ERC-7201 style: keccak256(encode(address, base))
    return keccak256(
        encodeAbiParameters(
            [{ type: 'address' }, { type: 'bytes32' }],
            [account, override.base as `0x${string}`]
        )
    )
}

function computeAllowanceStorageSlot(owner: Address, spender: Address, override: TokenOverride): `0x${string}` {
    // For allowance mapping: mapping(address owner => mapping(address spender => uint256))
    // Storage location: keccak256(spender, keccak256(owner, baseSlot))

    if ('slot' in override && !('base' in override)) {
        // Standard nested mapping at slot N (or custom allowanceSlot)
        const allowanceBaseSlot = override.allowanceSlot !== undefined
            ? BigInt(override.allowanceSlot)
            : BigInt(override.slot + 1)  // Default: balance_slot + 1

        const innerHash = keccak256(
            encodeAbiParameters(
                [{ type: 'address' }, { type: 'uint256' }],
                [owner, allowanceBaseSlot]
            )
        )
        return keccak256(
            encodeAbiParameters(
                [{ type: 'address' }, { type: 'bytes32' }],
                [spender, innerHash]
            )
        )
    }

    // ERC-7201 style: use allowanceBase if specified, otherwise use same base
    const allowanceBase = 'allowanceBase' in override && override.allowanceBase
        ? override.allowanceBase
        : override.base

    const innerHash = keccak256(
        encodeAbiParameters(
            [{ type: 'address' }, { type: 'bytes32' }],
            [owner, allowanceBase as `0x${string}`]
        )
    )
    return keccak256(
        encodeAbiParameters(
            [{ type: 'address' }, { type: 'bytes32' }],
            [spender, innerHash]
        )
    )
}

function computeStorageValue(balance: bigint, override: TokenOverride): `0x${string}` {
    const value = 'shift' in override ? balance << BigInt(override.shift) : balance
    return padHex(`0x${value.toString(16)}`, { size: 32 })
}

/**
 * Get state override for eth_call to set a token balance and allowance
 * @param token - Token contract address
 * @param account - Account to override balance for
 * @param balance - Desired balance
 * @param spender - Optional spender to set allowance for (if not provided, only balance is set)
 * @returns State override object for eth_call, or null if token not supported
 */
export function getOverride(
    token: Address,
    account: Address,
    balance: bigint,
    spender: Address  // Required! Must have allowance for whale pattern
): { [address: string]: { stateDiff: { [slot: string]: `0x${string}` } } } | null {
    if (!spender) throw new Error('spender is required for whale pattern - cannot be undefined')

    const override = tokens[token.toLowerCase()]
    if (!override) throw new Error(`Token ${token} not supported in getOverride. Add it to supported_tokens.json with value null`)

    const balanceSlot = computeStorageSlot(account, override)
    const balanceValue = computeStorageValue(balance, override)

    const stateDiff: { [slot: string]: `0x${string}` } = {
        [balanceSlot]: balanceValue
    }

    // Always set allowance - spender is required
    const allowanceSlot = computeAllowanceStorageSlot(account, spender, override)
    const allowanceValue = computeStorageValue(balance, override)
    stateDiff[allowanceSlot] = allowanceValue

    return {
        [token]: {
            stateDiff
        }
    }
}

/**
 * Check if a token is supported for balance overrides
 */
export function isSupported(token: Address): boolean {
    return token.toLowerCase() in tokens
}

/**
 * Get all supported token addresses
 */
export function getSupportedTokens(): Address[] {
    return Object.keys(tokens) as Address[]
}

