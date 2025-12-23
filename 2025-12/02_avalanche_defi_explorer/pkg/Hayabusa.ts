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
     * Uses RPC batching for parallel execution
     */
    async quote(requests: QuoteRequest[]): Promise<QuoteResult[]> {
        const results = await Promise.allSettled(
            requests.map(req => this._doQuote(req.path, req.amountIn))
        )

        return results.map((r, i) => {
            const req = requests[i]
            if (r.status === 'fulfilled') {
                return { path: req.path, amountIn: req.amountIn, amountOut: r.value }
            } else {
                // Capture revert data if available
                const err = r.reason
                let errorMessage = err?.message || 'failed'

                // Try to extract revert data in hex format
                if (err?.data) {
                    errorMessage += ` | data: ${err.data}`
                } else if (err?.cause?.data) {
                    errorMessage += ` | data: ${err.cause.data}`
                }

                return { path: req.path, amountIn: req.amountIn, amountOut: 0n, error: errorMessage }
            }
        })
    }

    private async _doQuote(path: Path, amountIn: bigint): Promise<bigint> {
        const WHALE_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' as Address
        const tokenIn = path[0].tokenIn as Address

        // Get override for BOTH balance and allowance using whale pattern
        const overrideObj = getOverride(tokenIn, WHALE_ADDRESS, amountIn, this.contract)

        // If override is null, token storage layout cannot be discovered
        if (!overrideObj) {
            throw new Error(`Token ${tokenIn} storage override not available (unsupported token)`)
        }

        const pools = path.map(leg => leg.pool)
        const poolTypes = path.map(leg => leg.poolType)
        const tokens = [...path.map(leg => leg.tokenIn), path[path.length - 1].tokenOut]

        const data = encodeFunctionData({
            abi: getAbi(),
            functionName: 'swap',  // Use swap() - msg.sender will be whale
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

        const result = await this.client.call({
            account: WHALE_ADDRESS, // Call from whale address
            to: this.contract,
            data,
            stateOverride
        })

        if (!result.data) throw new Error('No data returned')

        return decodeFunctionResult({
            abi: getAbi(),
            functionName: 'swap',
            data: result.data
        }) as bigint
    }
}
