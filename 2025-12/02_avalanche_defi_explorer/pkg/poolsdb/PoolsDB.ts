import * as lmdb from 'lmdb'
import { type PoolType } from '../providers/_types.ts'

type StoredPool = {
    address: string
    tokens: string[]
    poolType: PoolType
    providerName: string
}

export class PoolsDB {
    private database: lmdb.Database
    private poolsInMem: Map<string, StoredPool>

    constructor(database: lmdb.Database) {
        this.database = database
        this.poolsInMem = new Map()

        this.database.getRange({ start: "0x" + "00".repeat(20), end: "0x" + "ff".repeat(20) })
            .forEach(({ key, value }) => {
                if (!String(key).startsWith("0x") || String(key).length !== 42) throw new Error("PoolsDB: unexpected key in database")
                this.poolsInMem.set(String(key), value)
            })
    }

    addPool(pool: string, tokenIn: string, tokenOut: string, poolType: PoolType, providerName: string) {
        pool = pool.toLowerCase()
        if (this.poolsInMem.has(pool) && this.poolsInMem.get(pool)!.tokens.includes(tokenIn) && this.poolsInMem.get(pool)!.tokens.includes(tokenOut)) {
            if (this.poolsInMem.get(pool)!.poolType !== poolType) throw new Error("PoolsDB: implementation error: pool type mismatch")
            if (this.poolsInMem.get(pool)!.providerName !== providerName) throw new Error("PoolsDB: implementation error: provider name mismatch")

            return
        }

        const tokenSet = new Set([tokenIn, tokenOut])
        if (this.poolsInMem.has(pool)) {
            for (let token of this.poolsInMem.get(pool)!.tokens) {
                tokenSet.add(token)
            }
        }

        const storedPool: StoredPool = {
            address: pool,
            tokens: Array.from(tokenSet),
            poolType: poolType,
            providerName: providerName
        }
        this.poolsInMem.set(pool, storedPool)
        this.database.put(pool, storedPool)
    }

    getAllPools(): StoredPool[] {
        return Array.from(this.poolsInMem.values())
    }
}   