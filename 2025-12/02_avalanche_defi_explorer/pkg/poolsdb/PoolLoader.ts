import * as fs from 'fs'
import { type PoolType } from '../providers/_types.ts'
import { type Leg } from '../Hayabusa.ts'

export type StoredPool = {
    address: string
    tokens: string[]
    poolType: PoolType
    providerName: string
    swapCount: number
}

/**
 * Save pools to a semicolon-separated file
 * Format: address:providerName:poolType:swapCount:token1:token2:token3...
 */
export function savePools(filePath: string, pools: Iterable<{
    address: string;
    providerName: string;
    poolType: number;
    tokens: Iterable<string>;
    swapCount: number;
}>): void {
    const lines: string[] = []

    for (const pool of pools) {
        const tokens = Array.from(pool.tokens).sort()
        const line = `${pool.address.toLowerCase()}:${pool.providerName}:${pool.poolType}:${pool.swapCount}:${tokens.join(':').toLowerCase()}`
        lines.push(line)
    }

    // Sort lines for consistent output
    lines.sort()

    fs.writeFileSync(filePath, lines.join('\n') + '\n')
}

/**
 * Load pools from a semicolon-separated file
 * Format: address:providerName:poolType:swapCount:token1:token2:token3...
 */
export function loadPools(filePath: string): Map<string, StoredPool> {
    const pools = new Map<string, StoredPool>()

    if (!fs.existsSync(filePath)) {
        console.warn(`Pools file not found: ${filePath}. Starting with empty pool set.`)
        return pools
    }

    const content = fs.readFileSync(filePath, 'utf-8')
    const lines = content.split('\n').filter(line => line.trim().length > 0)

    for (const line of lines) {
        const parts = line.split(':')
        if (parts.length < 5) {
            console.warn(`Invalid pool line (too few parts): ${line}`)
            continue
        }

        const address = parts[0].toLowerCase()
        const providerName = parts[1]
        const poolType = parseInt(parts[2]) as PoolType
        const swapCount = parseInt(parts[3])
        const tokens = parts.slice(4).map(t => t.toLowerCase())

        if (!address.startsWith('0x') || address.length !== 42) {
            console.warn(`Invalid pool address: ${address}`)
            continue
        }

        if (isNaN(poolType)) {
            console.warn(`Invalid pool type: ${parts[2]}`)
            continue
        }

        if (isNaN(swapCount) || swapCount < 0) {
            console.warn(`Invalid swap count: ${parts[3]}`)
            continue
        }

        pools.set(address, {
            address,
            providerName,
            poolType,
            tokens,
            swapCount
        })
    }

    console.log(`Loaded ${pools.size} pools from ${filePath}`)
    return pools
}
