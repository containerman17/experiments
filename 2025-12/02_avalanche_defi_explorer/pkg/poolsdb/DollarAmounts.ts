/**
 * DollarAmounts - Calculates how much of any token can be bought with 1 dollar (USDC)
 * Uses PoolMaster for route discovery and Hayabusa for quoting
 * Caches results in memory for 1 hour
 */

import type { Address } from 'viem'
import { PoolMaster } from './PoolMaster.ts'
import { Hayabusa, type QuoteRequest } from '../Hayabusa.ts'

const USDC = '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e'
const ONE_DOLLAR = 1_000_000n // 1 USDC = 1,000,000 (6 decimals)
const CACHE_DURATION_MS = 60 * 60 * 1000 // 1 hour
const MAX_ROUTES = 100

interface CacheEntry {
    amountOut: bigint
    timestamp: number
}

export class DollarAmounts {
    private poolMaster: PoolMaster
    private hayabusa: Hayabusa
    private cache = new Map<string, CacheEntry>()

    constructor(poolsFilePath: string, hayabusaInstance: Hayabusa) {
        this.poolMaster = new PoolMaster(poolsFilePath)
        this.hayabusa = hayabusaInstance
    }

    /**
     * Get how much of a given token can be bought with 1 dollar (USDC)
     * Results are cached for 1 hour
     * @param token - The token address to quote
     * @returns Amount of token that can be bought with 1 USDC
     * @throws Error if no valid route exists
     */
    async getAmountForOneDollar(token: string): Promise<bigint> {
        // Normalize token address to lowercase for consistent cache keys
        token = token.toLowerCase()

        // Check cache
        const cached = this.cache.get(token)
        if (cached && Date.now() - cached.timestamp < CACHE_DURATION_MS) {
            return cached.amountOut
        }

        // USDC to USDC is always 1:1
        if (token === USDC) {
            const result = ONE_DOLLAR
            this.cache.set(token, { amountOut: result, timestamp: Date.now() })
            return result
        }

        // Find routes from USDC to token
        const routes = this.poolMaster.findRoutes(USDC, token, MAX_ROUTES)

        if (routes.length === 0) {
            throw new Error(`No route found from USDC to token ${token}`)
        }

        // Limit to MAX_ROUTES
        const limitedRoutes = routes.slice(0, MAX_ROUTES)

        // Create quote requests
        const requests: QuoteRequest[] = limitedRoutes.map(route => ({
            path: route,
            amountIn: ONE_DOLLAR
        }))

        // Get quotes
        const results = await this.hayabusa.quote(requests)

        // Find best quote (highest output)
        const validResults = results.filter(r => r.amountOut > 0n && !r.error)

        if (validResults.length === 0) {
            throw new Error(`All quotes failed for token ${token}. Found ${routes.length} routes but none returned valid quotes.`)
        }

        const bestQuote = validResults.reduce((best, current) =>
            current.amountOut > best.amountOut ? current : best
        )

        // Cache result
        this.cache.set(token, {
            amountOut: bestQuote.amountOut,
            timestamp: Date.now()
        })

        return bestQuote.amountOut
    }

    /**
     * Batch fetch amounts for multiple tokens
     * More efficient than calling getAmountForOneDollar individually
     */
    async getAmountsForOneDollar(tokens: string[]): Promise<Map<string, bigint>> {
        const results = new Map<string, bigint>()

        // Process all tokens in parallel and propagate any errors
        const promises = tokens.map(async (token) => {
            const amount = await this.getAmountForOneDollar(token)
            results.set(token.toLowerCase(), amount)
        })

        await Promise.all(promises)
        return results
    }

    /**
     * Clear the cache for a specific token or all tokens
     */
    clearCache(token?: string) {
        if (token) {
            this.cache.delete(token.toLowerCase())
        } else {
            this.cache.clear()
        }
    }

    /**
     * Get cache statistics
     */
    getCacheStats() {
        return {
            size: this.cache.size,
            entries: Array.from(this.cache.entries()).map(([token, entry]) => ({
                token,
                amountOut: entry.amountOut,
                age: Date.now() - entry.timestamp
            }))
        }
    }
}