import { type Log } from "viem"

// Pool type constants - matches Solidity constants
export const POOL_TYPE_UNIV3 = 0 as const
export const POOL_TYPE_ALGEBRA = 1 as const
export const POOL_TYPE_LFJ_V1 = 2 as const
export const POOL_TYPE_LFJ_V2 = 3 as const
export const POOL_TYPE_DODO = 4 as const
export const POOL_TYPE_WOOFI = 5 as const
export const POOL_TYPE_BALANCER_V3 = 6 as const
export const POOL_TYPE_PHARAOH_V1 = 7 as const
export const POOL_TYPE_V2 = 8 as const

export interface CachedRPC {
    getAddress(address: string, method: string): Promise<string>
    getDecimals(token: string): Promise<number>
    getSymbol(token: string): Promise<string>
    ethCall(to: string, method: string): Promise<string>
}

export type PoolType =
    | typeof POOL_TYPE_UNIV3
    | typeof POOL_TYPE_ALGEBRA
    | typeof POOL_TYPE_LFJ_V1
    | typeof POOL_TYPE_LFJ_V2
    | typeof POOL_TYPE_DODO
    | typeof POOL_TYPE_WOOFI
    | typeof POOL_TYPE_BALANCER_V3
    | typeof POOL_TYPE_PHARAOH_V1
    | typeof POOL_TYPE_V2

export interface PoolProvider {
    name: string
    poolType: PoolType  // matches Solidity constant
    topics: string[]  // event signatures to filter

    // Parse relevant logs from a block
    processLogs(logs: Log[], cachedRPC: CachedRPC): Promise<SwapEvent[]>

    // Given a pool address, return zeroForOne direction for tokenA->tokenB
    getDirection(pool: string, tokenIn: string): boolean
}


export interface SwapEvent {
    pool: string
    tokenIn: string
    tokenOut: string
    amountIn: bigint
    amountOut: bigint
    poolType: PoolType
    providerName: string
    error?: string
}