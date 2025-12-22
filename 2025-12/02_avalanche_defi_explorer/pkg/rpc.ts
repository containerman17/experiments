import { keccak256, toHex, decodeAbiParameters } from 'viem'
import { type CachedRPC } from './providers/_types.ts'
import * as lmdb from 'lmdb'

const memCache = new Map<string, string>()

// Get 4-byte selector from method signature
function selector(sig: string): string {
    return keccak256(toHex(sig)).slice(0, 10)
}

export class RpcClient implements CachedRPC {
    private rpcUrl: string
    private cache: lmdb.Database<string, string>

    constructor(rpcUrl: string, cache: lmdb.Database<string, string>) {
        this.rpcUrl = rpcUrl
        this.cache = cache
    }

    async ethCall(to: string, method: string, cacheForever = true): Promise<string> {
        const cacheKey = `${to}:${method}`

        const memCached = memCache.get(cacheKey)
        if (memCached !== undefined) {
            return memCached
        }

        if (cacheForever) {
            const cached = this.cache.get(cacheKey) as string | undefined
            if (cached !== undefined) {
                memCache.set(cacheKey, cached)
                return cached
            }
        }

        const data = selector(method)

        const response = await fetch(this.rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_call',
                params: [{ to, data }, 'latest'],
            }),
        })

        const json = await response.json() as { result?: string; error?: { message: string } }

        if (json.error) {
            throw new Error(json.error.message)
        }

        const result = json.result ?? '0x'


        if (cacheForever) {
            memCache.set(cacheKey, result)
            this.cache.put(cacheKey, result)
        }

        return result
    }

    async getAddress(contract: string, method: string): Promise<string> {
        const result = await this.ethCall(contract, method)
        if (!result || result === '0x' || result.length < 42) throw new Error('Invalid address result')
        // Address is right-padded in 32 bytes, take last 40 hex chars
        return '0x' + result.slice(-40).toLowerCase()
    }

    async getDecimals(token: string): Promise<number> {
        const result = await this.ethCall(token, 'decimals()')
        return parseInt(result, 16)
    }

    async getSymbol(token: string): Promise<string> {
        const result = await this.ethCall(token, 'symbol()')
        if (!result || result === '0x' || result.length < 66) return '???'
        try {
            const [decoded] = decodeAbiParameters([{ type: 'string' }], result as `0x${string}`)
            return decoded
        } catch {
            return '???'
        }
    }
}


