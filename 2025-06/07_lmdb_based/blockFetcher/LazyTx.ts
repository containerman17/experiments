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

export class LazyLog {
    constructor(private logData: Uint8Array[]) { }

    #address?: string
    get address() {
        if (!this.logData[0]) throw new Error('Missing log address data')
        return this.#address ??= deserializeFixedHex(this.logData[0])
    }

    #topics?: string[]
    get topics() {
        if (!this.logData[1]) throw new Error('Missing log topics data')
        return this.#topics ??= (this.logData[1] as unknown as Uint8Array[]).map(topic => deserializeFixedHex(topic))
    }

    #data?: string
    get data() {
        if (!this.logData[2]) throw new Error('Missing log data')
        return this.#data ??= deserializeFixedHex(this.logData[2])
    }

    #blockNumber?: string
    get blockNumber() {
        if (!this.logData[3]) throw new Error('Missing log blockNumber data')
        return this.#blockNumber ??= deserializeHex(this.logData[3])
    }

    #transactionHash?: string
    get transactionHash() {
        if (!this.logData[4]) throw new Error('Missing log transactionHash data')
        return this.#transactionHash ??= deserializeFixedHex(this.logData[4])
    }

    #transactionIndex?: string
    get transactionIndex() {
        if (!this.logData[5]) throw new Error('Missing log transactionIndex data')
        return this.#transactionIndex ??= deserializeHex(this.logData[5])
    }

    #blockHash?: string
    get blockHash() {
        if (!this.logData[6]) throw new Error('Missing log blockHash data')
        return this.#blockHash ??= deserializeFixedHex(this.logData[6])
    }

    #logIndex?: string
    get logIndex() {
        if (!this.logData[7]) throw new Error('Missing log logIndex data')
        return this.#logIndex ??= deserializeHex(this.logData[7])
    }

    #removed?: boolean
    get removed() {
        if (!this.logData[8]) throw new Error('Missing log removed data')
        return this.#removed ??= this.logData[8][0] === 1
    }
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
        if (!this.parts[0]) throw new Error('Missing hash data')
        return this.#hash ??= deserializeFixedHex(this.parts[0])
    }

    #blockHash?: string
    get blockHash() {
        if (!this.parts[1]) throw new Error('Missing blockHash data')
        return this.#blockHash ??= deserializeFixedHex(this.parts[1])
    }

    #blockNumber?: string
    get blockNumber() {
        if (!this.parts[2]) throw new Error('Missing blockNumber data')
        return this.#blockNumber ??= deserializeHex(this.parts[2])
    }

    #transactionIndex?: string
    get transactionIndex() {
        if (!this.parts[3]) throw new Error('Missing transactionIndex data')
        return this.#transactionIndex ??= deserializeHex(this.parts[3])
    }

    #from?: string
    get from() {
        if (!this.parts[4]) throw new Error('Missing from data')
        return this.#from ??= deserializeFixedHex(this.parts[4])
    }

    #to?: string | null
    get to() {
        if (!this.parts[5]) throw new Error('Missing to data')
        return this.#to ??= deserializeNullableAddress(this.parts[5])
    }

    #value?: string
    get value() {
        if (!this.parts[6]) throw new Error('Missing value data')
        return this.#value ??= deserializeHex(this.parts[6])
    }

    #gas?: string
    get gas() {
        if (!this.parts[7]) throw new Error('Missing gas data')
        return this.#gas ??= deserializeHex(this.parts[7])
    }

    #gasPrice?: string
    get gasPrice() {
        if (!this.parts[8]) throw new Error('Missing gasPrice data')
        return this.#gasPrice ??= deserializeHex(this.parts[8])
    }

    #input?: string
    get input() {
        if (!this.parts[9]) throw new Error('Missing input data')
        return this.#input ??= deserializeFixedHex(this.parts[9])
    }

    #nonce?: string
    get nonce() {
        if (!this.parts[10]) throw new Error('Missing nonce data')
        return this.#nonce ??= deserializeHex(this.parts[10])
    }

    #type?: string
    get type() {
        if (!this.parts[11]) throw new Error('Missing type data')
        return this.#type ??= deserializeHex(this.parts[11])
    }

    #chainId?: string
    get chainId() {
        if (!this.parts[12]) throw new Error('Missing chainId data')
        return this.#chainId ??= deserializeHex(this.parts[12])
    }

    #v?: string
    get v() {
        if (!this.parts[13]) throw new Error('Missing v data')
        return this.#v ??= deserializeHex(this.parts[13])
    }

    #r?: string
    get r() {
        if (!this.parts[14]) throw new Error('Missing r data')
        return this.#r ??= deserializeFixedHex(this.parts[14])
    }

    #s?: string
    get s() {
        if (!this.parts[15]) throw new Error('Missing s data')
        return this.#s ??= deserializeFixedHex(this.parts[15])
    }

    #maxFeePerGas?: string | undefined
    get maxFeePerGas() {
        if (!this.parts[16]) throw new Error('Missing maxFeePerGas data')
        return this.#maxFeePerGas ??= deserializeOptionalHex(this.parts[16])
    }

    #maxPriorityFeePerGas?: string | undefined
    get maxPriorityFeePerGas() {
        if (!this.parts[17]) throw new Error('Missing maxPriorityFeePerGas data')
        return this.#maxPriorityFeePerGas ??= deserializeOptionalHex(this.parts[17])
    }

    #accessList?: string[] | undefined
    get accessList() {
        if (this.#accessList !== undefined) return this.#accessList
        if (!this.parts[18]) throw new Error('Missing accessList data')
        const accessListPart = this.parts[18] as unknown as Uint8Array[]
        return this.#accessList = accessListPart.length === 0 ? undefined :
            accessListPart.map(item => deserializeFixedHex(item))
    }

    #yParity?: string | undefined
    get yParity() {
        if (!this.parts[19]) throw new Error('Missing yParity data')
        return this.#yParity ??= deserializeOptionalHex(this.parts[19])
    }

    /* Receipt fields */
    #contractAddress?: string | null
    get contractAddress() {
        if (!this.parts[20]) throw new Error('Missing contractAddress data')
        return this.#contractAddress ??= deserializeNullableAddress(this.parts[20])
    }

    #cumulativeGasUsed?: string
    get cumulativeGasUsed() {
        if (!this.parts[21]) throw new Error('Missing cumulativeGasUsed data')
        return this.#cumulativeGasUsed ??= deserializeHex(this.parts[21])
    }

    #effectiveGasPrice?: string
    get effectiveGasPrice() {
        if (!this.parts[22]) throw new Error('Missing effectiveGasPrice data')
        return this.#effectiveGasPrice ??= deserializeHex(this.parts[22])
    }

    #gasUsed?: string
    get gasUsed() {
        if (!this.parts[23]) throw new Error('Missing gasUsed data')
        return this.#gasUsed ??= deserializeHex(this.parts[23])
    }

    #logs?: LazyLog[]
    get logs() {
        if (this.#logs) return this.#logs
        if (!this.parts[24]) throw new Error('Missing logs data')
        const logsPart = this.parts[24] as unknown as Uint8Array[][]
        return this.#logs = logsPart.map(logData => new LazyLog(logData))
    }

    #logsBloom?: string
    get logsBloom() {
        if (!this.parts[25]) throw new Error('Missing logsBloom data')
        return this.#logsBloom ??= deserializeFixedHex(this.parts[25])
    }

    #status?: string
    get status() {
        if (!this.parts[26]) throw new Error('Missing status data')
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
