import { RLP } from "@ethereumjs/rlp"
import { bytesToHex } from '@noble/curves/abstract/utils'
import { Transaction, Receipt, Log } from "./evmTypes"
import { IS_DEVELOPMENT } from '../config'

const TX_SIG_V1 = 0x01 as const


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

const deserializeOptionalHex = (b: Uint8Array) => {
    return b.length === 0 ? undefined : deserializeHex(b)
}

const deserializeNullableAddress = (b: Uint8Array) => {
    return b.length === 0 ? null : deserializeFixedHex(b)
}

export class LazyTx {
    private parts: readonly Uint8Array[]

    constructor(private blob: Uint8Array) {
        if (blob[0] !== TX_SIG_V1) throw new Error('bad sig')
        // skip sig (1 byte) – cheap, produces views not copies
        this.parts = RLP.decode(blob.subarray(1)) as Uint8Array[]
    }

    /* Transaction fields */
    #hash?: string
    get hash() {
        return this.#hash ??= deserializeFixedHex(this.parts[0])
    }

    #blockHash?: string
    get blockHash() {
        return this.#blockHash ??= deserializeFixedHex(this.parts[1])
    }

    #blockNumber?: string
    get blockNumber() {
        return this.#blockNumber ??= deserializeHex(this.parts[2])
    }

    #transactionIndex?: string
    get transactionIndex() {
        return this.#transactionIndex ??= deserializeHex(this.parts[3])
    }

    #from?: string
    get from() {
        return this.#from ??= deserializeFixedHex(this.parts[4])
    }

    #to?: string | null
    get to() {
        return this.#to ??= deserializeNullableAddress(this.parts[5])
    }

    #value?: string
    get value() {
        return this.#value ??= deserializeHex(this.parts[6])
    }

    #gas?: string
    get gas() {
        return this.#gas ??= deserializeHex(this.parts[7])
    }

    #gasPrice?: string
    get gasPrice() {
        return this.#gasPrice ??= deserializeHex(this.parts[8])
    }

    #input?: string
    get input() {
        return this.#input ??= deserializeFixedHex(this.parts[9])
    }

    #nonce?: string
    get nonce() {
        return this.#nonce ??= deserializeHex(this.parts[10])
    }

    #type?: string
    get type() {
        return this.#type ??= deserializeHex(this.parts[11])
    }

    #chainId?: string
    get chainId() {
        return this.#chainId ??= deserializeHex(this.parts[12])
    }

    #v?: string
    get v() {
        return this.#v ??= deserializeHex(this.parts[13])
    }

    #r?: string
    get r() {
        return this.#r ??= deserializeFixedHex(this.parts[14])
    }

    #s?: string
    get s() {
        return this.#s ??= deserializeFixedHex(this.parts[15])
    }

    #maxFeePerGas?: string
    get maxFeePerGas() {
        return this.#maxFeePerGas ??= deserializeOptionalHex(this.parts[16])
    }

    #maxPriorityFeePerGas?: string
    get maxPriorityFeePerGas() {
        return this.#maxPriorityFeePerGas ??= deserializeOptionalHex(this.parts[17])
    }

    #accessList?: string[]
    get accessList() {
        if (this.#accessList) return this.#accessList
        const accessListPart = this.parts[18] as unknown as Uint8Array[]
        return this.#accessList = accessListPart.length === 0 ? undefined :
            accessListPart.map(item => deserializeFixedHex(item))
    }

    #yParity?: string
    get yParity() {
        return this.#yParity ??= deserializeOptionalHex(this.parts[19])
    }

    /* Receipt fields */
    #contractAddress?: string | null
    get contractAddress() {
        return this.#contractAddress ??= deserializeNullableAddress(this.parts[20])
    }

    #cumulativeGasUsed?: string
    get cumulativeGasUsed() {
        return this.#cumulativeGasUsed ??= deserializeHex(this.parts[21])
    }

    #effectiveGasPrice?: string
    get effectiveGasPrice() {
        return this.#effectiveGasPrice ??= deserializeHex(this.parts[22])
    }

    #gasUsed?: string
    get gasUsed() {
        return this.#gasUsed ??= deserializeHex(this.parts[23])
    }

    #logs?: Log[]
    get logs() {
        if (this.#logs) return this.#logs
        const logsPart = this.parts[24] as unknown as Uint8Array[][]
        return this.#logs = logsPart.map(logData => ({
            address: deserializeFixedHex(logData[0]),
            topics: (logData[1] as unknown as Uint8Array[]).map(topic => deserializeFixedHex(topic)),
            data: deserializeFixedHex(logData[2]),
            blockNumber: deserializeHex(logData[3]),
            transactionHash: deserializeFixedHex(logData[4]),
            transactionIndex: deserializeHex(logData[5]),
            blockHash: deserializeFixedHex(logData[6]),
            logIndex: deserializeHex(logData[7]),
            removed: logData[8][0] === 1
        }))
    }

    #logsBloom?: string
    get logsBloom() {
        return this.#logsBloom ??= deserializeFixedHex(this.parts[25])
    }

    #status?: string
    get status() {
        return this.#status ??= deserializeHex(this.parts[26])
    }

    /* if you ever need full RLP again */
    raw() {
        return this.blob
    }
}

export const encodeLazyTx = (tx: Transaction, receipt: Receipt): Uint8Array => {
    if (IS_DEVELOPMENT) {
        // Validate transaction fields
        const expectedTxFields = new Set([
            'hash', 'blockHash', 'blockNumber', 'transactionIndex', 'from', 'to',
            'value', 'gas', 'gasPrice', 'input', 'nonce', 'type', 'chainId',
            'v', 'r', 's', 'maxFeePerGas', 'maxPriorityFeePerGas', 'accessList', 'yParity'
        ])

        const actualTxFields = new Set(Object.keys(tx))
        const unusedTxFields = [...actualTxFields].filter(field => !expectedTxFields.has(field))

        if (unusedTxFields.length > 0) {
            throw new Error(`encodeLazyTx development: Unused transaction fields: ${unusedTxFields.join(', ')}`)
        }

        // Validate receipt fields
        const expectedReceiptFields = new Set([
            'blockHash', 'blockNumber', 'contractAddress', 'cumulativeGasUsed',
            'effectiveGasPrice', 'from', 'gasUsed', 'logs', 'logsBloom', 'status',
            'to', 'transactionHash', 'transactionIndex', 'type'
        ])

        const actualReceiptFields = new Set(Object.keys(receipt))
        const unusedReceiptFields = [...actualReceiptFields].filter(field => !expectedReceiptFields.has(field))

        if (unusedReceiptFields.length > 0) {
            throw new Error(`encodeLazyTx development: Unused receipt fields: ${unusedReceiptFields.join(', ')}`)
        }
    }

    const data = [
        // Transaction fields
        tx.hash,
        tx.blockHash,
        tx.blockNumber,
        tx.transactionIndex,
        tx.from,
        tx.to || '',
        tx.value,
        tx.gas,
        tx.gasPrice,
        tx.input,
        tx.nonce,
        tx.type,
        tx.chainId,
        tx.v,
        tx.r,
        tx.s,
        tx.maxFeePerGas || '',
        tx.maxPriorityFeePerGas || '',
        tx.accessList || [],
        tx.yParity || '',
        // Receipt fields
        receipt.contractAddress || '',
        receipt.cumulativeGasUsed,
        receipt.effectiveGasPrice,
        receipt.gasUsed,
        receipt.logs.map(log => [
            log.address,
            log.topics,
            log.data,
            log.blockNumber,
            log.transactionHash,
            log.transactionIndex,
            log.blockHash,
            log.logIndex,
            log.removed ? [1] : [0]
        ]),
        receipt.logsBloom,
        receipt.status
    ]

    const rlp = RLP.encode(data)
    const out = new Uint8Array(1 + rlp.length)
    out[0] = TX_SIG_V1
    out.set(rlp, 1)
    return out
}
