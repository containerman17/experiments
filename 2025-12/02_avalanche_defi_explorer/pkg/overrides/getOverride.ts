import { keccak256, encodeAbiParameters, padHex, type Address } from 'viem'
import TOKENS from './supported_tokens.json' with { type: 'json' }

type TokenOverride =
    | { slot: number }                          // mapping(address=>uint) at slot N
    | { base: `0x${string}` }                   // ERC-7201: keccak256(encode(addr, base))
    | { base: `0x${string}`; shift: number }    // ERC-7201 packed: value << shift

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

function computeStorageValue(balance: bigint, override: TokenOverride): `0x${string}` {
    const value = 'shift' in override ? balance << BigInt(override.shift) : balance
    return padHex(`0x${value.toString(16)}`, { size: 32 })
}

/**
 * Get state override for eth_call to set a token balance
 * @param token - Token contract address
 * @param account - Account to override balance for
 * @param balance - Desired balance
 * @returns State override object for eth_call, or null if token not supported
 */
export function getOverride(
    token: Address,
    account: Address,
    balance: bigint
): { [address: string]: { stateDiff: { [slot: string]: `0x${string}` } } } | null {
    const override = tokens[token.toLowerCase()]
    if (!override) throw new Error(`Token ${token} not supported in getOverride. Add it to supported_tokens.json with value null`)

    const slot = computeStorageSlot(account, override)
    const value = computeStorageValue(balance, override)

    return {
        [token]: {
            stateDiff: {
                [slot]: value
            }
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

