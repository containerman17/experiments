import { DollarAmounts } from "./DollarAmounts.ts";
import { type StoredPool } from "./PoolLoader.ts";
import { Hayabusa, type Leg, type QuoteRequest } from "../Hayabusa.ts";
import { type SwapEvent } from "../providers/_types.ts"

export class DollarPrice {
    private readonly dollarAmounts: DollarAmounts
    private readonly pools: StoredPool[]
    private readonly hayabusa: Hayabusa

    constructor(
        dollarAmounts: DollarAmounts,
        pools: Map<string, StoredPool>,
        hayabusa: Hayabusa,
    ) {
        this.dollarAmounts = dollarAmounts
        this.pools = Array.from(pools.values())
        this.hayabusa = hayabusa
    }

    private priceCache: Map<string, bigint> = new Map()
    private cacheValidPools: Set<string> = new Set()

    private getKey(pool: string, tokenIn: string, tokenOut: string) {
        return `${pool}-${tokenIn}-${tokenOut}`
    }

    bustCaches(pools: string[]) {
        for (const pool of pools) {
            this.cacheValidPools.delete(pool)
        }
    }

    private priceCallbacks: ((events: SwapEvent[]) => void)[] = []
    subscribeToPrices(callback: (events: SwapEvent[]) => void) {
        this.priceCallbacks.push(callback)
    }

    async fetchPrices() {
        // Collect all pools that need quoting
        const poolsToQuote = this.pools.filter(pool => !this.cacheValidPools.has(pool.address))
        if (poolsToQuote.length === 0) return

        // Gather all unique tokens we need dollar amounts for
        const allTokens = new Set<string>()
        for (const pool of poolsToQuote) {
            for (const token of pool.tokens) {
                allTokens.add(token)
            }
        }

        // Fetch dollar amounts for all tokens at once - handle failures gracefully
        const dollarAmounts = new Map<string, bigint>()
        await Promise.all(Array.from(allTokens).map(async (token) => {
            try {
                const amount = await this.dollarAmounts.getAmountForOneDollar(token)
                dollarAmounts.set(token.toLowerCase(), amount)
            } catch (e: any) {
                console.warn(`Failed to get dollar amount for ${token}: ${e.message}`)
            }
        }))

        // Build all quote requests in one pass
        const quoteRequests: QuoteRequest[] = []
        const requestToPool: StoredPool[] = [] // Track which pool each request belongs to

        for (const pool of poolsToQuote) {
            const tokens = pool.tokens
            for (let i = 0; i < tokens.length; i++) {
                for (let j = 0; j < tokens.length; j++) {
                    if (i === j) continue

                    const tokenIn = tokens[i].toLowerCase()
                    const amountIn = dollarAmounts.get(tokenIn)
                    if (amountIn === undefined) {
                        continue // Skip tokens we couldn't price in USD
                    }

                    const leg: Leg = {
                        pool: pool.address,
                        poolType: pool.poolType,
                        tokenIn: tokens[i],
                        tokenOut: tokens[j],
                    }
                    quoteRequests.push({
                        path: [leg],
                        amountIn: amountIn,
                    })
                    requestToPool.push(pool)
                }
            }
        }

        // One huge batch quote
        const quotes = await this.hayabusa.quote(quoteRequests)

        // Collect all swap events
        const swapEvents: SwapEvent[] = []

        // Process all results
        for (let i = 0; i < quotes.length; i++) {
            const quote = quotes[i]
            const pool = requestToPool[i]
            const leg = quote.path[0]
            const cacheKey = this.getKey(pool.address, leg.tokenIn, leg.tokenOut)

            if (quote.amountOut > 0n) {
                this.priceCache.set(cacheKey, quote.amountOut)
            }

            // Collect swap event
            swapEvents.push({
                pool: pool.address,
                tokenIn: leg.tokenIn,
                tokenOut: leg.tokenOut,
                amountIn: dollarAmounts.get(leg.tokenIn.toLowerCase())!,
                amountOut: quote.amountOut,
                poolType: pool.poolType,
                providerName: pool.providerName,
                error: quote.error,
            })
        }

        // Call callbacks once with all events
        this.priceCallbacks.forEach(callback => callback(swapEvents))

        // Mark all pools as cached
        for (const pool of poolsToQuote) {
            this.cacheValidPools.add(pool.address)
        }
    }
}