/**
 * Hayabusa (隼) - TS wrapper for Hayabusa.sol contract
 * Handles quoting via eth_call + state overrides
 */

import { readFileSync } from 'fs'
import { createPublicClient, http, encodeFunctionData, decodeFunctionResult, type PublicClient, type Address } from 'viem'
import { avalanche } from 'viem/chains'
import { getOverride } from './overrides/getOverride.ts'


export interface Leg {
    pool: string
    poolType: number
    tokenIn: string
    tokenOut: string
}


const dir = import.meta.dirname
let abi: readonly unknown[]

function getAbi(): readonly unknown[] {
    if (!abi) {
        const json = JSON.parse(readFileSync(`${dir}/../contracts/Hayabusa.json`, 'utf-8'))
        abi = json.abi
    }
    return abi
}

export type Path = Leg[]

export interface QuoteRequest {
    path: Path
    amountIn: bigint
}

export interface QuoteResult {
    path: Path
    amountIn: bigint
    amountOut: bigint
    error?: string
}

export class Hayabusa {
    private client: PublicClient
    private contract: Address
    private cache = new Map<string, bigint>()

    constructor(rpcUrl: string, contractAddress: string) {
        this.client = createPublicClient({
            chain: avalanche,
            transport: http(rpcUrl, {
                batch: {
                    batchSize: 500,
                    wait: 5
                }
            })
        })
        this.contract = contractAddress as Address
    }

    /**
     * Quote multiple paths with different amounts
     * Uses RPC batching for parallel execution, with caching
     */
    async quote(requests: QuoteRequest[]): Promise<QuoteResult[]> {
        const results = await Promise.allSettled(
            requests.map(req => {
                const key = this._cacheKey(req.path, req.amountIn)
                const cached = this.cache.get(key)
                if (cached !== undefined) return Promise.resolve(cached)
                return this._doQuote(req.path, req.amountIn).then(out => {
                    this.cache.set(key, out)
                    return out
                })
            })
        )

        return results.map((r, i) => {
            const req = requests[i]
            if (r.status === 'fulfilled') {
                return { path: req.path, amountIn: req.amountIn, amountOut: r.value }
            } else {
                return { path: req.path, amountIn: req.amountIn, amountOut: 0n, error: r.reason?.message || 'failed' }
            }
        })
    }

    /**
     * Invalidate cache entries containing any of these pools
     */
    bustCache(pools: string[]): void {
        const poolSet = new Set(pools.map(p => p.toLowerCase()))
        for (const key of this.cache.keys()) {
            // Key format: pool1:pool2:...:amountIn
            const parts = key.split(':')
            const keyPools = parts.slice(0, -1)
            if (keyPools.some(p => poolSet.has(p))) {
                this.cache.delete(key)
            }
        }
    }

    private _cacheKey(path: Path, amountIn: bigint): string {
        return path.map(leg => leg.pool.toLowerCase()).join(':') + ':' + amountIn.toString()
    }

    private async _doQuote(path: Path, amountIn: bigint): Promise<bigint> {
        const tokenIn = path[0].tokenIn as Address
        const overrideObj = getOverride(tokenIn, this.contract, amountIn)

        const pools = path.map(leg => leg.pool)
        const poolTypes = path.map(leg => leg.poolType)
        const tokens = [...path.map(leg => leg.tokenIn), path[path.length - 1].tokenOut]

        const data = encodeFunctionData({
            abi: getAbi(),
            functionName: 'quote',
            args: [pools, poolTypes, tokens, amountIn]
        })

        // Convert override format for viem v2
        let stateOverride: { address: Address; stateDiff: { slot: `0x${string}`; value: `0x${string}` }[] }[] | undefined
        if (overrideObj) {
            const [addr, override] = Object.entries(overrideObj)[0]
            const stateDiff = Object.entries(override.stateDiff).map(([slot, value]) => ({
                slot: slot as `0x${string}`,
                value: value as `0x${string}`
            }))
            stateOverride = [{ address: addr as Address, stateDiff }]
        }

        // console.log(`Calling Hayabusa at ${this.contract}`)
        // console.log(`Data: ${data}`)
        // console.log(`StateOverride: ${JSON.stringify(stateOverride, null, 2)}`)

        const result = await this.client.call({
            account: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', // Use a real address to avoid 0x0 issues
            to: this.contract,
            data,
            stateOverride
        })

        if (!result.data) throw new Error('No data returned')

        return decodeFunctionResult({
            abi: getAbi(),
            functionName: 'quote',
            data: result.data
        }) as bigint
    }
}
