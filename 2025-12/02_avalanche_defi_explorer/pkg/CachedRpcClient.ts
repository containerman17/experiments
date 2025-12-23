import { keccak256, toHex, decodeAbiParameters } from 'viem'
import * as lmdb from 'lmdb'
import path from 'path'


// Get 4-byte selector from method signature
function selector(sig: string): string {
    return keccak256(toHex(sig)).slice(0, 10)
}

const rootDb = lmdb.open({
    path: path.join(import.meta.dirname, "../data/cached_rpc"),
    compression: true
})

class CachedRpcClient {
    private rpcUrl: string
    private cache: lmdb.Database
    private cachedCount = 0
    private rpcCount = 0
    private inflight: Map<string, Promise<string>> = new Map()

    constructor(rpcUrl: string) {
        this.rpcUrl = rpcUrl

        this.cache = rootDb.openDB({
            name: rpcUrl,
            compression: true
        })

        setInterval(() => {
            if (this.rpcCount === 0) return
            console.log(`RPC Stats: ${this.cachedCount} cached, ${this.rpcCount} non-cached served`)
            this.cachedCount = 0
            this.rpcCount = 0
        }, 1000)
    }

    async ethCall(to: string, method: string): Promise<string> {
        const cacheKey = `${to}:${method}`

        const cached = this.cache.get(cacheKey) as string | undefined
        if (cached !== undefined) {
            this.cachedCount++
            // Check if this is a cached error
            if (cached.startsWith('ERROR:')) {
                throw new Error(cached.slice(6))
            }
            return cached
        }

        // Check if there's already an in-flight request for this key
        const pending = this.inflight.get(cacheKey)
        if (pending) {
            return pending
        }

        // Create the fetch promise and store it
        const fetchPromise = this.doFetch(to, method, cacheKey)
        this.inflight.set(cacheKey, fetchPromise)

        try {
            return await fetchPromise
        } finally {
            this.inflight.delete(cacheKey)
        }
    }

    private async doFetch(to: string, method: string, cacheKey: string): Promise<string> {
        const data = selector(method)
        this.rpcCount++

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
            // Cache RPC errors (these are deterministic, e.g., method not found, revert)
            const errorValue = `ERROR:${json.error.message}`
            this.cache.put(cacheKey, errorValue)
            await this.cache.flushed
            throw new Error(json.error.message)
        }

        const result = json.result ?? '0x'

        this.cache.put(cacheKey, result)
        await this.cache.flushed

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


const cache = new Map<string, CachedRpcClient>()

export function getCachedRpcClient(RPC_URL: string) {
    if (!cache.has(RPC_URL)) {
        cache.set(RPC_URL, new CachedRpcClient(RPC_URL))
    }
    return cache.get(RPC_URL)!
}