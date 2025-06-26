// LazyBlock.ts
import { RLP } from '@ethereumjs/rlp'
import { bytesToHex } from '@noble/curves/abstract/utils'
import { Block } from './evmTypes'
import { IS_DEVELOPMENT } from '../config'

const BLOCK_SIG_V1 = 0x01 as const

const deserializeNumber = (b: Uint8Array) => {
    let n = 0n
    for (const byte of b) n = (n << 8n) | BigInt(byte)
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('overflow')
    return Number(n)
}

const deserializeHex = (b: Uint8Array) => {
    if (b.length === 0) return '0x0'
    // Remove leading zeros but keep at least one digit
    let start = 0
    while (start < b.length - 1 && b[start] === 0) start++
    return '0x' + bytesToHex(b.slice(start))
}

const deserializeFixedHex = (b: Uint8Array) => {
    return '0x' + bytesToHex(b)
}

export class LazyBlock {
    private parts: readonly Uint8Array[]

    constructor(private blob: Uint8Array) {
        if (blob[0] !== BLOCK_SIG_V1) throw new Error('bad sig')
        // skip sig (1 byte) – cheap, produces views not copies
        this.parts = RLP.decode(blob.subarray(1)) as Uint8Array[]
    }

    /* lazy-cached getters */
    #hash?: string
    get hash() {
        return this.#hash ??= deserializeFixedHex(this.parts[0])
    }

    #number?: string
    get number() {
        return this.#number ??= deserializeHex(this.parts[1])
    }

    #parentHash?: string
    get parentHash() {
        return this.#parentHash ??= deserializeFixedHex(this.parts[2])
    }

    #timestamp?: string
    get timestamp() {
        return this.#timestamp ??= deserializeHex(this.parts[3])
    }

    #gasLimit?: string
    get gasLimit() {
        return this.#gasLimit ??= deserializeHex(this.parts[4])
    }

    #gasUsed?: string
    get gasUsed() {
        return this.#gasUsed ??= deserializeHex(this.parts[5])
    }

    #baseFeePerGas?: string
    get baseFeePerGas() {
        return this.#baseFeePerGas ??= deserializeHex(this.parts[6])
    }

    #miner?: string
    get miner() {
        return this.#miner ??= deserializeFixedHex(this.parts[7])
    }

    #difficulty?: string
    get difficulty() {
        return this.#difficulty ??= deserializeHex(this.parts[8])
    }

    #totalDifficulty?: string
    get totalDifficulty() {
        return this.#totalDifficulty ??= deserializeHex(this.parts[9])
    }

    #size?: string
    get size() {
        return this.#size ??= deserializeHex(this.parts[10])
    }

    #stateRoot?: string
    get stateRoot() {
        return this.#stateRoot ??= deserializeFixedHex(this.parts[11])
    }

    #transactionsRoot?: string
    get transactionsRoot() {
        return this.#transactionsRoot ??= deserializeFixedHex(this.parts[12])
    }

    #receiptsRoot?: string
    get receiptsRoot() {
        return this.#receiptsRoot ??= deserializeFixedHex(this.parts[13])
    }

    #logsBloom?: string
    get logsBloom() {
        return this.#logsBloom ??= deserializeFixedHex(this.parts[14])
    }

    #extraData?: string
    get extraData() {
        return this.#extraData ??= deserializeFixedHex(this.parts[15])
    }

    #mixHash?: string
    get mixHash() {
        return this.#mixHash ??= deserializeFixedHex(this.parts[16])
    }

    #nonce?: string
    get nonce() {
        return this.#nonce ??= deserializeFixedHex(this.parts[17])
    }

    #sha3Uncles?: string
    get sha3Uncles() {
        return this.#sha3Uncles ??= deserializeFixedHex(this.parts[18])
    }

    #uncles?: string[]
    get uncles() {
        if (this.#uncles) return this.#uncles
        const unclesPart = this.parts[19] as unknown as Uint8Array[]
        return this.#uncles = unclesPart.map(uncle => deserializeFixedHex(uncle))
    }

    #transactionCount?: number
    get transactionCount() {
        if (this.#transactionCount !== undefined) return this.#transactionCount
        return this.#transactionCount = deserializeNumber(this.parts[20])
    }

    #blobGasUsed?: string
    get blobGasUsed() {
        return this.#blobGasUsed ??= deserializeHex(this.parts[21])
    }

    #excessBlobGas?: string
    get excessBlobGas() {
        return this.#excessBlobGas ??= deserializeHex(this.parts[22])
    }

    #parentBeaconBlockRoot?: string
    get parentBeaconBlockRoot() {
        return this.#parentBeaconBlockRoot ??= deserializeFixedHex(this.parts[23])
    }

    #blockGasCost?: string
    get blockGasCost() {
        return this.#blockGasCost ??= deserializeHex(this.parts[24])
    }

    /* if you ever need full RLP again */
    raw() {
        return this.blob
    }
}

/* ── encoder ─────────────────────────────────────────────── */
export const encodeLazyBlock = (i: Block): Uint8Array => {
    if (IS_DEVELOPMENT) {
        // Validate no unused fields
        const expectedFields = new Set([
            'hash', 'number', 'parentHash', 'timestamp', 'gasLimit', 'gasUsed',
            'baseFeePerGas', 'miner', 'difficulty', 'totalDifficulty', 'size',
            'stateRoot', 'transactionsRoot', 'receiptsRoot', 'logsBloom',
            'extraData', 'mixHash', 'nonce', 'sha3Uncles', 'uncles', 'transactions',
            'blobGasUsed', 'excessBlobGas', 'parentBeaconBlockRoot', 'blockGasCost'
        ])

        const actualFields = new Set(Object.keys(i))
        const unusedFields = [...actualFields].filter(field => !expectedFields.has(field))

        if (unusedFields.length > 0) {
            throw new Error(`encodeLazyBlock development: Unused fields in block: ${unusedFields.join(', ')}`)
        }

        for (const field of expectedFields) {
            if (i[field] === undefined) {
                throw new Error(`encodeLazyBlock development: Missing field: ${field}`)
            }
        }
    }

    const data = [
        i.hash,
        i.number,
        i.parentHash,
        i.timestamp,
        i.gasLimit,
        i.gasUsed,
        i.baseFeePerGas,
        i.miner,
        i.difficulty,
        i.totalDifficulty,
        i.size,
        i.stateRoot,
        i.transactionsRoot,
        i.receiptsRoot,
        i.logsBloom,
        i.extraData,
        i.mixHash,
        i.nonce,
        i.sha3Uncles,
        i.uncles,
        i.transactions.length,
        i.blobGasUsed,
        i.excessBlobGas,
        i.parentBeaconBlockRoot,
        i.blockGasCost
    ]

    const rlp = RLP.encode(data)
    const out = new Uint8Array(1 + rlp.length)
    out[0] = BLOCK_SIG_V1
    out.set(rlp, 1)
    return out
}
