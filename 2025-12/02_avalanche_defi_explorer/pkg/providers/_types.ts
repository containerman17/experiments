import { type Log } from "viem"

export type CachedRPC = {
    getAddress: (address: string, method: string) => Promise<string>
    ethCall: (to: string, method: string, cacheForever?: boolean) => Promise<string>
}

export interface PoolProvider {
    name: string
    poolType: number  // matches Solidity constant
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
    poolType: number
    providerName: string
}