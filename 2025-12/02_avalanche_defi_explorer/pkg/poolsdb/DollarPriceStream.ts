import { type StoredPool } from "./PoolLoader.ts"
import { type SwapEvent } from "../providers/_types.ts"
import { Hayabusa, type QuoteRequest } from "../Hayabusa.ts"
import { DollarAmounts } from "./DollarAmounts.ts"

export class DollarPriceStream {
    private priceCache: Record<string, SwapEvent> = {}
    private pools: Map<string, StoredPool>
    private hayabusa: Hayabusa
    private dollarAmounts: DollarAmounts
    private isRefetching = false
    private subscribers: ((priceUpdate: SwapEvent) => void)[] = []

    constructor(pools: Map<string, StoredPool>, hayabusa: Hayabusa) {
        this.pools = pools
        this.hayabusa = hayabusa
        this.dollarAmounts = new DollarAmounts(pools, hayabusa)
    }

    private getCacheKey(pool: string, tokenIn: string, tokenOut: string): string {
        return `${pool}:${tokenIn}:${tokenOut}`
    }

    public cacheBustedCallback(pools: string[]) {
        for (const pool of pools) {
            if (pool.length !== 42) throw new Error("Invalid pool address length: " + pool + " (should be 42)")
        }

        const poolSet = new Set(pools)
        for (const key in this.priceCache) {
            const pool = key.slice(0, 42)
            if (poolSet.has(pool)) {
                delete this.priceCache[key]
            }
        }
    }

    private notifySubscribers(swapEvent: SwapEvent) {
        for (const cb of this.subscribers) {
            cb(swapEvent)
        }
    }

    public async refetchPrices() {
        if (this.isRefetching) throw new Error("Already refetching prices")
        this.isRefetching = true

        try {
            // 1. Identify all unique tokens to prime DollarAmounts cache
            const uniqueTokens = new Set<string>()
            for (const pool of this.pools.values()) {
                for (const token of pool.tokens) {
                    uniqueTokens.add(token)
                }
            }

            // 2. Prime DollarAmounts cache in parallel
            // Note: getOneDollarAmount internally quotes via Hayabusa and caches.
            await Promise.all(
                Array.from(uniqueTokens).map(t => this.dollarAmounts.getOneDollarAmount(t))
            )

            // 3. Build quote requests for all pool directions not in cache
            const requests: QuoteRequest[] = []
            const metadata: { pool: StoredPool, tokenIn: string, tokenOut: string, cacheKey: string }[] = []

            for (const [poolAddr, pool] of this.pools) {
                for (const tokenIn of pool.tokens) {
                    for (const tokenOut of pool.tokens) {
                        if (tokenIn === tokenOut) continue

                        const cacheKey = this.getCacheKey(poolAddr, tokenIn, tokenOut)
                        if (this.priceCache[cacheKey]) continue

                        // We already primed the cache, so this should be fast (or cached exception)
                        try {
                            const amountIn = await this.dollarAmounts.getOneDollarAmount(tokenIn)
                            requests.push({
                                path: [{
                                    pool: poolAddr,
                                    poolType: pool.poolType,
                                    tokenIn,
                                    tokenOut
                                }],
                                amountIn
                            })
                            metadata.push({ pool, tokenIn, tokenOut, cacheKey })
                        } catch (e) {
                            throw new Error(`Failed to get quote for pool ${poolAddr} ${tokenIn} -> ${tokenOut}: ${e}`)
                        }
                    }
                }
            }

            if (requests.length === 0) return

            // 4. Execute quotes and update cache
            const results = await this.hayabusa.quote(requests)
            for (let i = 0; i < results.length; i++) {
                const res = results[i]
                const meta = metadata[i]

                if (!res.error && res.amountOut > 0n) {
                    const swapEvent: SwapEvent = {
                        pool: meta.pool.address,
                        tokenIn: meta.tokenIn,
                        tokenOut: meta.tokenOut,
                        amountIn: res.amountIn,
                        amountOut: res.amountOut,
                        poolType: meta.pool.poolType,
                        providerName: meta.pool.providerName
                    }
                    this.priceCache[meta.cacheKey] = swapEvent
                    this.notifySubscribers(swapEvent)
                }
            }
        } finally {
            this.isRefetching = false
        }
    }

    subscribeToPriceUpdates(callback: (priceUpdate: SwapEvent) => void) {
        this.subscribers.push(callback)
    }
}