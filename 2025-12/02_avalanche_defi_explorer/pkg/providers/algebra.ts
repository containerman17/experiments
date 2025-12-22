import { type Log, decodeAbiParameters } from 'viem'
import { type PoolProvider, type SwapEvent, type CachedRPC } from './_types.ts'

const ALGEBRA_FACTORY = '0x512eb749541b7cf294be882d636218c84a5e9e5f'

// Same swap topic as UniV3
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'

const tokenCache = new Map<string, { token0: string; token1: string }>()

async function getPoolTokens(pool: string, cachedRPC: CachedRPC): Promise<{ token0: string; token1: string } | null> {
    const cached = tokenCache.get(pool)
    if (cached) return cached

    try {
        const [factory, token0, token1] = await Promise.all([
            cachedRPC.getAddress(pool, 'factory()'),
            cachedRPC.getAddress(pool, 'token0()'),
            cachedRPC.getAddress(pool, 'token1()'),
        ])

        if (factory !== ALGEBRA_FACTORY) return null

        const tokens = { token0, token1 }
        tokenCache.set(pool, tokens)
        return tokens
    } catch {
        return null
    }
}

export const algebra: PoolProvider = {
    name: 'algebra',
    poolType: 1, // ALGEBRA
    topics: [SWAP_TOPIC],

    async processLogs(logs: Log[], cachedRPC: CachedRPC): Promise<SwapEvent[]> {
        const swaps: SwapEvent[] = []

        const logsByPool = new Map<string, Log[]>()
        for (const log of logs) {
            if (log.topics[0] !== SWAP_TOPIC) continue
            const pool = log.address.toLowerCase()
            if (!logsByPool.has(pool)) logsByPool.set(pool, [])
            logsByPool.get(pool)!.push(log)
        }

        for (const [pool, poolLogs] of logsByPool) {
            const tokens = await getPoolTokens(pool, cachedRPC)
            if (!tokens) continue

            for (const log of poolLogs) {
                const [amount0, amount1] = decodeAbiParameters(
                    [
                        { type: 'int256', name: 'amount0' },
                        { type: 'int256', name: 'amount1' },
                        { type: 'uint160', name: 'sqrtPriceX96' },
                        { type: 'uint128', name: 'liquidity' },
                        { type: 'int24', name: 'tick' },
                    ],
                    log.data
                )

                const zeroForOne = amount0 > 0n
                const tokenIn = zeroForOne ? tokens.token0 : tokens.token1
                const tokenOut = zeroForOne ? tokens.token1 : tokens.token0
                const amountIn = zeroForOne ? amount0 : -amount1
                const amountOut = zeroForOne ? -amount1 : amount0

                if (amountIn <= 0n || amountOut <= 0n) continue

                swaps.push({
                    pool,
                    tokenIn,
                    tokenOut,
                    amountIn,
                    amountOut: amountOut < 0n ? -amountOut : amountOut,
                    poolType: algebra.poolType,
                    providerName: algebra.name,
                })
            }
        }

        return swaps
    },

    getDirection(pool: string, tokenIn: string): boolean {
        const tokens = tokenCache.get(pool)
        if (!tokens) return true
        return tokenIn.toLowerCase() === tokens.token0
    },
}

