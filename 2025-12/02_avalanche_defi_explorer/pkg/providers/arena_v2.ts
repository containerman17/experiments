import { type Log, decodeAbiParameters, keccak256, toHex } from 'viem'
import { type PoolProvider, type SwapEvent, type CachedRPC, POOL_TYPE_V2 } from './_types.ts'

// ArenaTrade Factory
const ARENA_V2_FACTORY = '0xf16784dcaf838a3e16bef7711a62d12413c39bd1'

// V2 Swap event (same as Uniswap V2)
const V2_SWAP_TOPIC = keccak256(toHex('Swap(address,uint256,uint256,uint256,uint256,address)'))

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

        if (factory.toLowerCase() !== ARENA_V2_FACTORY) return null

        const tokens = { token0, token1 }
        tokenCache.set(pool, tokens)
        return tokens
    } catch {
        return null
    }
}

export const arenaV2: PoolProvider = {
    name: 'arena_v2',
    poolType: POOL_TYPE_V2, // Standard V2 interface
    topics: [V2_SWAP_TOPIC],

    async processLogs(logs: Log[], cachedRPC: CachedRPC): Promise<SwapEvent[]> {
        const swaps: SwapEvent[] = []

        const logsByPool = new Map<string, Log[]>()
        for (const log of logs) {
            if (log.topics[0] !== V2_SWAP_TOPIC) continue
            const pool = log.address.toLowerCase()
            if (!logsByPool.has(pool)) logsByPool.set(pool, [])
            logsByPool.get(pool)!.push(log)
        }

        for (const [pool, poolLogs] of logsByPool) {
            const tokens = await getPoolTokens(pool, cachedRPC)
            if (!tokens) continue

            for (const log of poolLogs) {
                try {
                    const [amount0In, amount1In, amount0Out, amount1Out] = decodeAbiParameters(
                        [
                            { type: 'uint256', name: 'amount0In' },
                            { type: 'uint256', name: 'amount1In' },
                            { type: 'uint256', name: 'amount0Out' },
                            { type: 'uint256', name: 'amount1Out' },
                        ],
                        log.data
                    )

                    // Determine direction
                    const zeroForOne = amount0In > 0n && amount1Out > 0n
                    const tokenIn = zeroForOne ? tokens.token0 : tokens.token1
                    const tokenOut = zeroForOne ? tokens.token1 : tokens.token0
                    const amountIn = zeroForOne ? amount0In : amount1In
                    const amountOut = zeroForOne ? amount1Out : amount0Out

                    if (amountIn <= 0n || amountOut <= 0n) continue

                    swaps.push({
                        pool,
                        tokenIn,
                        tokenOut,
                        amountIn,
                        amountOut,
                        poolType: arenaV2.poolType,
                        providerName: arenaV2.name,
                    })
                } catch {
                    continue
                }
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


