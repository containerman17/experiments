export interface PoolPriceData {
    pool: string
    tokenIn: string
    tokenOut: string
    tokenInSymbol: string
    tokenOutSymbol: string
    tokenInDecimals: number
    tokenOutDecimals: number
    amountIn: string
    amountOut: string
    providerName: string
    error?: string
    updatedAt: number
}

export function getPriceKey(p: { pool: string; tokenIn: string; tokenOut: string }): string {
    return `${p.pool.toLowerCase()}:${p.tokenIn.toLowerCase()}:${p.tokenOut.toLowerCase()}`
}
