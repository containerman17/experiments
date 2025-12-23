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

    private priceCallbacks: ((event: SwapEvent) => void)[] = []
    subscribeToPrices(callback: (event: SwapEvent) => void) {
        this.priceCallbacks.push(callback)
    }

    async fetchPrices() {
        for (const pool of this.pools) {
            if (this.cacheValidPools.has(pool.address)) {
                continue
            }

            const tokens = pool.tokens

            const possibleTokenCombinations: string[][] = []
            for (let i = 0; i < tokens.length; i++) {
                for (let j = 0; j < tokens.length; j++) {
                    if (i === j) continue
                    possibleTokenCombinations.push([tokens[i], tokens[j]])
                }
            }

            const dollarAmounts = await this.dollarAmounts.getAmountsForOneDollar(pool.tokens)

            const quoteRequests: QuoteRequest[] = []
            for (const tokenCombo of possibleTokenCombinations) {
                const leg: Leg = {
                    pool: pool.address,
                    poolType: pool.poolType,
                    tokenIn: tokenCombo[0],
                    tokenOut: tokenCombo[1],
                }
                quoteRequests.push({
                    path: [leg],
                    amountIn: dollarAmounts.get(tokenCombo[0])!,
                })
            }

            const quotes = await this.hayabusa.quote(quoteRequests)
            for (const quote of quotes) {
                const cacheKey = this.getKey(pool.address, quote.path[0].tokenIn, quote.path[0].tokenOut)
                if (quote.amountOut > 0n) {
                    this.priceCache.set(cacheKey, quote.amountOut)
                }
            }

            this.cacheValidPools.add(pool.address)

            // Emit swap events for each token combination we quoted
            for (const quote of quotes) {
                const leg = quote.path[0]
                this.priceCallbacks.forEach(callback => callback({
                    pool: pool.address,
                    tokenIn: leg.tokenIn,
                    tokenOut: leg.tokenOut,
                    amountIn: dollarAmounts.get(leg.tokenIn)!,
                    amountOut: quote.amountOut,
                    poolType: pool.poolType,
                    providerName: pool.providerName,
                    error: quote.error,
                }))
            }
        }
    }
}