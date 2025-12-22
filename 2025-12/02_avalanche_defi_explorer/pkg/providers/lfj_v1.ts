import { type Log, decodeAbiParameters, keccak256, toHex } from 'viem'
import { type PoolProvider, type SwapEvent, type CachedRPC } from './_types.ts'

const LFJ_V1_FACTORY = '0x9ad6c38be94206ca50bb0d90783181662f0cfa10'

// V1 Swap (Uniswap V2 style): Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)
const V1_SWAP_TOPIC = keccak256(toHex('Swap(address,uint256,uint256,uint256,uint256,address)'))

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

        if (factory !== LFJ_V1_FACTORY) return null

        const tokens = { token0, token1 }
        tokenCache.set(pool, tokens)
        return tokens
    } catch {
        return null
    }
}

export const lfjV1: PoolProvider = {
    name: 'lfj_v1',
    poolType: 2, // LFJ_V1
    topics: [V1_SWAP_TOPIC],

    async processLogs(logs: Log[], cachedRPC: CachedRPC): Promise<SwapEvent[]> {
        const swaps: SwapEvent[] = []

        const logsByPool = new Map<string, Log[]>()
        for (const log of logs) {
            if (log.topics[0] !== V1_SWAP_TOPIC) continue
            const pool = log.address.toLowerCase()
            if (!logsByPool.has(pool)) logsByPool.set(pool, [])
            logsByPool.get(pool)!.push(log)
        }

        for (const [pool, poolLogs] of logsByPool) {
            const tokens = await getPoolTokens(pool, cachedRPC)
            if (!tokens) continue

            for (const log of poolLogs) {
                // Decode: uint amount0In, uint amount1In, uint amount0Out, uint amount1Out
                const [amount0In, amount1In, amount0Out, amount1Out] = decodeAbiParameters(
                    [
                        { type: 'uint256', name: 'amount0In' },
                        { type: 'uint256', name: 'amount1In' },
                        { type: 'uint256', name: 'amount0Out' },
                        { type: 'uint256', name: 'amount1Out' },
                    ],
                    log.data
                )

                // Determine direction: one of the In amounts is non-zero
                let tokenIn: string, tokenOut: string, amountIn: bigint, amountOut: bigint

                if (amount0In > 0n) {
                    tokenIn = tokens.token0
                    tokenOut = tokens.token1
                    amountIn = amount0In
                    amountOut = amount1Out
                } else {
                    tokenIn = tokens.token1
                    tokenOut = tokens.token0
                    amountIn = amount1In
                    amountOut = amount0Out
                }

                if (amountIn <= 0n || amountOut <= 0n) continue

                swaps.push({
                    pool,
                    tokenIn,
                    tokenOut,
                    amountIn,
                    amountOut,
                    poolType: lfjV1.poolType,
                    providerName: lfjV1.name,
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

