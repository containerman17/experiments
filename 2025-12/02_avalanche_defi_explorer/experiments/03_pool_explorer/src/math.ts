import BigNumber from 'bignumber.js'
import { type PoolPriceData, getPriceKey } from './types'

// Configure BigNumber for high precision
BigNumber.config({
    DECIMAL_PLACES: 36,
    ROUNDING_MODE: BigNumber.ROUND_DOWN
})

// Memoization cache for rate calculations
// Key: priceKey + amountIn + amountOut (to invalidate on price update)
const rateCache = new Map<string, BigNumber>()

function getRateCacheKey(p: PoolPriceData): string {
    return `${getPriceKey(p)}:${p.amountIn}:${p.amountOut}`
}

/**
 * Calculate the rate (amountOut/amountIn) with full precision.
 * Results are cached to avoid redundant BigNumber operations.
 */
export function getRate(p: PoolPriceData): BigNumber {
    const cacheKey = getRateCacheKey(p)
    const cached = rateCache.get(cacheKey)
    if (cached) return cached

    const amountIn = new BigNumber(p.amountIn)
    const amountOut = new BigNumber(p.amountOut)

    if (amountIn.isZero()) {
        rateCache.set(cacheKey, new BigNumber(0))
        return new BigNumber(0)
    }

    // rate = (amountOut / 10^decimalsOut) / (amountIn / 10^decimalsIn)
    //      = amountOut * 10^decimalsIn / (amountIn * 10^decimalsOut)
    const decimalsDiff = p.tokenInDecimals - p.tokenOutDecimals

    let rate: BigNumber
    if (decimalsDiff >= 0) {
        rate = amountOut.times(new BigNumber(10).pow(decimalsDiff)).div(amountIn)
    } else {
        rate = amountOut.div(new BigNumber(10).pow(-decimalsDiff)).div(amountIn)
    }

    rateCache.set(cacheKey, rate)
    return rate
}

/**
 * Clear the rate cache. Call when prices are fully refreshed.
 */
export function clearRateCache(): void {
    rateCache.clear()
}

/**
 * Multiply multiple rates together with full precision.
 */
export function multiplyRates(...rates: BigNumber[]): BigNumber {
    return rates.reduce((acc, r) => acc.times(r), new BigNumber(1))
}

/**
 * Format a rate for display (6 decimal places).
 */
export function formatRate(rate: BigNumber): string {
    return rate.toFixed(6)
}

/**
 * Format efficiency as a percentage (4 decimal places).
 */
export function formatEfficiency(efficiency: BigNumber): string {
    return efficiency.times(100).toFixed(4) + '%'
}

/**
 * Check if efficiency >= 1 (profitable).
 */
export function isProfitable(efficiency: BigNumber): boolean {
    return efficiency.gte(1)
}

/**
 * Check if efficiency >= threshold.
 */
export function isNearProfitable(efficiency: BigNumber, threshold: number = 0.99): boolean {
    return efficiency.gte(threshold)
}
