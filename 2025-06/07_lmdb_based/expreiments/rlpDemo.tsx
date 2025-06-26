import { RLP } from '@ethereumjs/rlp'
import { bytesToHex } from '@noble/curves/abstract/utils';
import { Block } from '../blockFetcher/evmTypes';
import { serializeHex, serializeFixedLenHex, serializeNumber, deserializeHex, deserializeFixedLenHex, deserializeNumber } from './serialize';
import { Buffer } from 'buffer';
import { Packr } from 'msgpackr';

// Create structured msgpackr with record definitions
const structuredPackr = new Packr({
    useRecords: true,
    structures: [
        // Transaction structure - define field order
        {
            Class: 'Transaction',
            fields: [
                'blockHash', 'blockNumber', 'from', 'gas', 'gasPrice',
                'maxFeePerGas', 'maxPriorityFeePerGas', 'hash', 'input',
                'nonce', 'to', 'transactionIndex', 'value', 'type',
                'accessList', 'chainId', 'v', 'r', 's', 'yParity'
            ]
        },
        // Block structure - define field order  
        {
            Class: 'Block',
            fields: [
                'baseFeePerGas', 'blobGasUsed', 'blockGasCost', 'difficulty',
                'excessBlobGas', 'extraData', 'gasLimit', 'gasUsed', 'hash',
                'logsBloom', 'miner', 'mixHash', 'nonce', 'number',
                'parentBeaconBlockRoot', 'parentHash', 'receiptsRoot',
                'sha3Uncles', 'size', 'stateRoot', 'timestamp',
                'totalDifficulty', 'transactionsRoot', 'uncles', 'transactions'
            ]
        }
    ]
})

function encodeBlockMsgpack(block: Block): Uint8Array {
    // Transform transactions to have consistent structure for msgpackr
    const structuredBlock = {
        ...block,
        transactions: block.transactions.map(tx => ({
            blockHash: tx.blockHash,
            blockNumber: tx.blockNumber,
            from: tx.from,
            gas: tx.gas,
            gasPrice: tx.gasPrice,
            maxFeePerGas: tx.maxFeePerGas,
            maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
            hash: tx.hash,
            input: tx.input,
            nonce: tx.nonce,
            to: tx.to,
            transactionIndex: tx.transactionIndex,
            value: tx.value,
            type: tx.type,
            accessList: tx.accessList,
            chainId: tx.chainId,
            v: tx.v,
            r: tx.r,
            s: tx.s,
            yParity: tx.yParity
        }))
    }
    return structuredPackr.pack(structuredBlock)
}

function decodeBlockMsgpack(data: Uint8Array): Block {
    return structuredPackr.unpack(data) as Block
}

function encodeBlock(block: Block) {
    const data = [
        block.baseFeePerGas,
        block.blobGasUsed,
        block.blockGasCost,
        block.difficulty,
        block.excessBlobGas,
        block.extraData,
        block.gasLimit,
        block.gasUsed,
        block.hash,
        block.logsBloom,
        block.miner,
        block.mixHash,
        block.nonce,
        block.number,
        block.parentBeaconBlockRoot,
        block.parentHash,
        block.receiptsRoot,
        block.sha3Uncles,
        block.size,
        block.stateRoot,
        block.timestamp,
        block.totalDifficulty,
        block.transactionsRoot,
        // Encode uncles array
        block.uncles.length
    ]
    // Add each uncle
    for (const uncle of block.uncles) {
        data.push(uncle)
    }
    data.push(block.transactions.length)
    for (const transaction of block.transactions) {
        data.push(transaction.blockHash)
        data.push(transaction.blockNumber)
        data.push(transaction.from)
        data.push(transaction.gas)
        data.push(transaction.gasPrice)
        data.push(transaction.maxFeePerGas)
        data.push(transaction.maxPriorityFeePerGas)
        data.push(transaction.hash)
        data.push(transaction.input)
        data.push(transaction.nonce)
        //hasTo
        if (transaction.to) {
            data.push('0x01')
            data.push(transaction.to)
        } else {
            data.push('0x00')
        }
        data.push(transaction.transactionIndex)
        data.push(transaction.value)
        data.push(transaction.type)
        data.push(transaction.accessList?.length ?? 0)
        for (const address of transaction.accessList ?? []) {
            data.push(address)
        }
        data.push(transaction.chainId)
        data.push(transaction.v)
        data.push(transaction.r)
        data.push(transaction.s)
        data.push(transaction.yParity)
    }

    const encoded = RLP.encode(data)
    return encoded
}

import block from './data/block.example.json'
const encoded = encodeBlock(block)
const customEncoded = encodeBlockCustom(block)
const msgpackEncoded = encodeBlockMsgpack(block)

console.log('RLP encoded size:', encoded.length, 'bytes')
console.log('Custom encoded size:', customEncoded.length, 'bytes')
console.log('Msgpack encoded size:', msgpackEncoded.length, 'bytes')
console.log('Custom vs RLP ratio:', (customEncoded.length / encoded.length * 100).toFixed(1) + '%')
console.log('Msgpack vs RLP ratio:', (msgpackEncoded.length / encoded.length * 100).toFixed(1) + '%')

// Test custom decoding
const customRestored = decodeBlockCustom(customEncoded)
console.log('Custom decode test - transactions match:',
    customRestored.transactions.length === block.transactions.length &&
    customRestored.transactions[0]?.to === block.transactions[0]?.to)

// Test msgpack decoding
const msgpackRestored = decodeBlockMsgpack(msgpackEncoded)
console.log('Msgpack decode test - transactions match:',
    msgpackRestored.transactions.length === block.transactions.length &&
    msgpackRestored.transactions[0]?.to === block.transactions[0]?.to)

const decoded = RLP.decode(encoded) as Uint8Array[]

// Convert decoded Uint8Arrays to hex strings
const decodedAsHex = decoded.map(item => bytesToHex(item))

console.log('Encoded (hex):', bytesToHex(encoded))
console.log('Decoded as hex:', decodedAsHex)

function numberToBytes(number: number): Uint8Array {
    if (number === 0) return new Uint8Array([0])
    const hex = number.toString(16)
    const paddedHex = hex.length % 2 === 0 ? hex : '0' + hex
    const bytes = new Uint8Array(paddedHex.length / 2)
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(paddedHex.substr(i * 2, 2), 16)
    }
    return bytes
}

function safeToHex(data: any, preserveLength: boolean = false): string {
    let hex: string;

    if (data instanceof Uint8Array) {
        hex = '0x' + bytesToHex(data);
    } else if (typeof data === 'string') {
        hex = data.startsWith('0x') ? data : '0x' + data;
    } else {
        return '0x0';
    }

    // Only strip leading zeros for variable-length fields, not fixed-length fields
    if (!preserveLength && hex.length > 3) { // More than just '0x0'
        const stripped = hex.slice(2).replace(/^0+/, '');
        hex = '0x' + (stripped || '0');
    }

    return hex;
}

function decodeBlock(encoded: Uint8Array): Block {
    const decoded = RLP.decode(encoded) as any[]
    let index = 0

    const safeToHex2 = (data: any, preserveLength: boolean = false): string => {
        return data ?? '0x0'
    }

    // Decode block fields
    const block: Block = {
        baseFeePerGas: safeToHex(decoded[index++]),
        blobGasUsed: safeToHex(decoded[index++]),
        blockGasCost: safeToHex(decoded[index++]),
        difficulty: safeToHex(decoded[index++]),
        excessBlobGas: safeToHex(decoded[index++]),
        extraData: safeToHex(decoded[index++], true), // preserve length for extraData
        gasLimit: safeToHex(decoded[index++]),
        gasUsed: safeToHex(decoded[index++]),
        hash: safeToHex(decoded[index++], true), // preserve length for hash (32 bytes)
        logsBloom: safeToHex(decoded[index++], true), // preserve length for logsBloom (256 bytes)
        miner: safeToHex(decoded[index++], true), // preserve length for miner (20 bytes)
        mixHash: safeToHex(decoded[index++], true), // preserve length for mixHash (32 bytes)
        nonce: safeToHex(decoded[index++], true), // preserve length for nonce (8 bytes)
        number: safeToHex(decoded[index++]),
        parentBeaconBlockRoot: safeToHex(decoded[index++], true), // preserve length for parentBeaconBlockRoot (32 bytes)
        parentHash: safeToHex(decoded[index++], true), // preserve length for parentHash (32 bytes)
        receiptsRoot: safeToHex(decoded[index++], true), // preserve length for receiptsRoot (32 bytes)
        sha3Uncles: safeToHex(decoded[index++], true), // preserve length for sha3Uncles (32 bytes)
        size: safeToHex(decoded[index++]),
        stateRoot: safeToHex(decoded[index++], true), // preserve length for stateRoot (32 bytes)
        timestamp: safeToHex(decoded[index++]),
        totalDifficulty: safeToHex(decoded[index++]),
        transactionsRoot: safeToHex(decoded[index++], true), // preserve length for transactionsRoot (32 bytes)
        uncles: [],
        transactions: []
    }

    // Decode uncles
    const uncleCount = bytesToNumber(decoded[index++])
    for (let i = 0; i < uncleCount; i++) {
        block.uncles.push(safeToHex(decoded[index++]))
    }

    // Decode number of transactions
    const txCount = bytesToNumber(decoded[index++])

    // Decode each transaction
    for (let i = 0; i < txCount; i++) {
        const transaction: any = {
            blockHash: safeToHex(decoded[index++], true), // preserve length for blockHash (32 bytes)
            blockNumber: safeToHex(decoded[index++]),
            from: safeToHex(decoded[index++], true), // preserve length for from address (20 bytes)
            gas: safeToHex(decoded[index++]),
            gasPrice: safeToHex(decoded[index++]),
            maxFeePerGas: safeToHex(decoded[index++]),
            maxPriorityFeePerGas: safeToHex(decoded[index++]),
            hash: safeToHex(decoded[index++], true), // preserve length for hash (32 bytes)
            input: safeToHex(decoded[index++]),
            nonce: safeToHex(decoded[index++])
        }

        // Handle conditional 'to' field
        const hasTo = safeToHex(decoded[index++])
        if (hasTo === '0x1') {
            transaction.to = safeToHex(decoded[index++], true) // preserve length for to address (20 bytes)
        } else {
            transaction.to = null
        }

        transaction.transactionIndex = safeToHex(decoded[index++])
        transaction.value = safeToHex(decoded[index++])
        transaction.type = safeToHex(decoded[index++])

        // Decode access list
        const accessListLength = bytesToNumber(decoded[index++])
        transaction.accessList = []
        for (let j = 0; j < accessListLength; j++) {
            transaction.accessList.push(safeToHex(decoded[index++]))
        }

        transaction.chainId = safeToHex(decoded[index++])
        transaction.v = safeToHex(decoded[index++])
        transaction.r = safeToHex(decoded[index++], true) // preserve length for r (32 bytes)
        transaction.s = safeToHex(decoded[index++], true) // preserve length for s (32 bytes)
        transaction.yParity = safeToHex(decoded[index++])

        block.transactions.push(transaction)
    }

    return block
}

function bytesToNumber(data: any): number {
    if (data instanceof Uint8Array) {
        return parseInt(bytesToHex(data), 16)
    }
    if (typeof data === 'string') {
        const hex = data.startsWith('0x') ? data.slice(2) : data
        return parseInt(hex, 16)
    }
    return 0
}

// Now restore the block from encoded data
const restoredBlock = decodeBlock(encoded)

console.log('Original block transactions count:', block.transactions.length)
console.log('Restored block transactions count:', restoredBlock.transactions.length)

// Check if transaction.to fields are properly restored
console.log('Original first transaction.to:', block.transactions[0]?.to)
console.log('Restored first transaction.to:', restoredBlock.transactions[0]?.to)

// Verify the restoration worked
const originalJSON = JSON.stringify(block)
const restoredJSON = JSON.stringify(restoredBlock)
console.log('Blocks match:', originalJSON.toLowerCase() === restoredJSON.toLowerCase())
console.log('JSON lengths - Original:', originalJSON.length, 'Restored:', restoredJSON.length)



// More detailed comparison
console.log('\n=== DETAILED COMPARISON ===')
console.log('Original uncle count:', block.uncles.length, 'Restored uncle count:', restoredBlock.uncles.length)
console.log('Original tx count:', block.transactions.length, 'Restored tx count:', restoredBlock.transactions.length)
console.log('Transaction.to handling test:')
console.log('  Original hasTo:', block.transactions[0]?.to !== null)
console.log('  Restored hasTo:', restoredBlock.transactions[0]?.to !== null)
console.log('  Values match:', block.transactions[0]?.to === restoredBlock.transactions[0]?.to)

// Test conditional transaction.to with null case
console.log('\n=== CONDITIONAL TRANSACTION.TO TEST ===')
const txWithoutTo = restoredBlock.transactions.find(tx => tx.to === null)
const txWithTo = restoredBlock.transactions.find(tx => tx.to !== null)
console.log('Found transaction without .to:', !!txWithoutTo)
console.log('Found transaction with .to:', !!txWithTo)
if (txWithTo) {
    console.log('Transaction with .to value:', txWithTo.to)
}

// Compression comparison
import { compress, decompress, compressLZ4, compressRaw, compressRawLZ4, decompressRaw } from '../compressor'

async function compareCompression() {
    console.log('\n=== COMPREHENSIVE BENCHMARK ===')

    // Original data sizes
    const jsonData = JSON.stringify(block)
    const rlpData = encoded
    const jsonBuffer = Buffer.from(jsonData, 'utf8')
    const rlpBuffer = Buffer.from(rlpData)

    console.log('Original sizes:')
    console.log('  JSON size:', jsonData.length, 'bytes')
    console.log('  RLP size:', rlpData.length, 'bytes')
    console.log('')

    const numRuns = 10000

    // Pre-compress all formats
    const msgpackBuffer = Buffer.from(msgpackEncoded)
    const formats = {
        'JSON+plain': { data: jsonBuffer, size: jsonBuffer.length },
        'JSON+lz4': { data: await compressLZ4(block), size: (await compressLZ4(block)).length },
        'JSON+zstd': { data: await compress(block, 1), size: (await compress(block, 1)).length },
        'RLP+plain': { data: rlpBuffer, size: rlpBuffer.length },
        'RLP+lz4': { data: await compressRawLZ4(rlpBuffer), size: (await compressRawLZ4(rlpBuffer)).length },
        'RLP+zstd': { data: await compressRaw(rlpBuffer, 1), size: (await compressRaw(rlpBuffer, 1)).length },
        'CUSTOM+plain': { data: Buffer.from(customEncoded), size: customEncoded.length },
        'CUSTOM+lz4': { data: await compressRawLZ4(Buffer.from(customEncoded)), size: (await compressRawLZ4(Buffer.from(customEncoded))).length },
        'CUSTOM+zstd': { data: await compressRaw(Buffer.from(customEncoded), 1), size: (await compressRaw(Buffer.from(customEncoded), 1)).length },
        'MSGPACK+plain': { data: msgpackBuffer, size: msgpackBuffer.length },
        'MSGPACK+lz4': { data: await compressRawLZ4(msgpackBuffer), size: (await compressRawLZ4(msgpackBuffer)).length },
        'MSGPACK+zstd': { data: await compressRaw(msgpackBuffer, 1), size: (await compressRaw(msgpackBuffer, 1)).length }
    }

    const results: Array<{
        format: string;
        time: number;
        avgTime: string;
        size: number;
    }> = []

    for (const [formatName, format] of Object.entries(formats)) {
        console.log(`Testing ${formatName}...`)

        let totalTime = 0

        if (formatName.startsWith('JSON+plain')) {
            // JSON plain: just parse JSON
            const start = Date.now()
            const promises = Array(numRuns).fill(0).map(() =>
                Promise.resolve(JSON.parse(format.data.toString('utf8')))
            )
            await Promise.all(promises)
            totalTime = Date.now() - start

        } else if (formatName.startsWith('JSON+')) {
            // JSON compressed: decompress + parse JSON
            const start = Date.now()
            const promises = Array(numRuns).fill(0).map(async () => {
                return await decompress(format.data)
            })
            await Promise.all(promises)
            totalTime = Date.now() - start

        } else if (formatName.startsWith('RLP+plain')) {
            // RLP plain: decode RLP + decode block
            const start = Date.now()
            const promises = Array(numRuns).fill(0).map(() =>
                Promise.resolve(decodeBlock(format.data))
            )
            await Promise.all(promises)
            totalTime = Date.now() - start

        } else if (formatName.startsWith('RLP+')) {
            // RLP compressed: decompress + decode RLP + decode block
            const start = Date.now()
            const promises = Array(numRuns).fill(0).map(async () => {
                const decompressed = await decompressRaw(format.data)
                return decodeBlock(decompressed)
            })
            await Promise.all(promises)
            totalTime = Date.now() - start
        } else if (formatName.startsWith('CUSTOM+plain')) {
            // CUSTOM plain: decode CUSTOM + decode block
            const start = Date.now()
            const promises = Array(numRuns).fill(0).map(() =>
                Promise.resolve(decodeBlockCustom(format.data))
            )
            await Promise.all(promises)
            totalTime = Date.now() - start

        } else if (formatName.startsWith('CUSTOM+')) {
            // CUSTOM compressed: decompress + decode CUSTOM + decode block
            const start = Date.now()
            const promises = Array(numRuns).fill(0).map(async () => {
                const decompressed = await decompressRaw(format.data)
                return decodeBlockCustom(decompressed)
            })
            await Promise.all(promises)
            totalTime = Date.now() - start
        } else if (formatName.startsWith('MSGPACK+plain')) {
            // MSGPACK plain: decode MSGPACK + decode block
            const start = Date.now()
            const promises = Array(numRuns).fill(0).map(() =>
                Promise.resolve(decodeBlockMsgpack(format.data))
            )
            await Promise.all(promises)
            totalTime = Date.now() - start

        } else if (formatName.startsWith('MSGPACK+')) {
            // MSGPACK compressed: decompress + decode MSGPACK + decode block
            const start = Date.now()
            const promises = Array(numRuns).fill(0).map(async () => {
                const decompressed = await decompressRaw(format.data)
                return decodeBlockMsgpack(decompressed)
            })
            await Promise.all(promises)
            totalTime = Date.now() - start
        }

        results.push({
            format: formatName,
            time: totalTime,
            avgTime: (totalTime / numRuns).toFixed(3),
            size: format.size
        })
    }

    // Create table
    console.log('\n=== RESULTS TABLE ===')
    console.log('Format'.padEnd(12), 'Time (ms)'.padEnd(10), 'Avg (ms)'.padEnd(10), 'Size (bytes)'.padEnd(12), 'Size Ratio')
    console.log('-'.repeat(70))

    for (const result of results) {
        const sizeRatio = ((result.size / jsonData.length) * 100).toFixed(1) + '%'
        console.log(
            result.format.padEnd(12),
            result.time.toString().padEnd(10),
            result.avgTime.padEnd(10),
            result.size.toString().padEnd(12),
            sizeRatio
        )
    }

    // Performance analysis
    console.log('\n=== PERFORMANCE ANALYSIS ===')
    const jsonPlain = results.find(r => r.format === 'JSON+plain')
    const rlpPlain = results.find(r => r.format === 'RLP+plain')
    const jsonLz4 = results.find(r => r.format === 'JSON+lz4')
    const rlpLz4 = results.find(r => r.format === 'RLP+lz4')
    const jsonZstd = results.find(r => r.format === 'JSON+zstd')
    const rlpZstd = results.find(r => r.format === 'RLP+zstd')

    console.log('Fastest overall:', results.reduce((min, curr) => curr.time < min.time ? curr : min).format)
    console.log('Smallest size:', results.reduce((min, curr) => curr.size < min.size ? curr : min).format)

    console.log('\nFormat decode speed comparison (plain formats):')
    console.log(`  RLP decode is ${((rlpPlain?.time ?? 0) / (jsonPlain?.time ?? 1) * 100).toFixed(1)}% of JSON parse time`)

    console.log('\nBest compressed options:')
    console.log(`  Speed: ${results.sort((a, b) => a.time - b.time)[0].format} (${results[0].avgTime}ms avg)`)
    console.log(`  Size: ${results.sort((a, b) => a.size - b.size)[0].format} (${results.sort((a, b) => a.size - b.size)[0].size} bytes)`)
}

compareCompression().catch(console.error)

function encodeBlockCustom(block: Block): Uint8Array {
    const parts: Buffer[] = []

    // Helper to write length-prefixed variable data
    const writeVariableBytes = (data: Uint8Array) => {
        if (data.length > 255) throw new Error('Variable data too long')
        parts.push(Buffer.from([data.length]))
        parts.push(data as Buffer)
    }

    // Serialize all block fields with length prefixes for variable data
    writeVariableBytes(serializeHex(block.baseFeePerGas ?? '0x0'))
    writeVariableBytes(serializeHex(block.blobGasUsed ?? '0x0'))
    writeVariableBytes(serializeHex(block.blockGasCost ?? '0x0'))
    writeVariableBytes(serializeHex(block.difficulty))
    writeVariableBytes(serializeHex(block.excessBlobGas ?? '0x0'))
    writeVariableBytes(serializeHex(block.extraData))
    writeVariableBytes(serializeHex(block.gasLimit))
    writeVariableBytes(serializeHex(block.gasUsed))
    parts.push(serializeFixedLenHex(block.hash, 32))
    parts.push(serializeFixedLenHex(block.logsBloom, 256))
    parts.push(serializeFixedLenHex(block.miner, 20))
    parts.push(serializeFixedLenHex(block.mixHash, 32))
    parts.push(serializeFixedLenHex(block.nonce, 8))
    writeVariableBytes(serializeHex(block.number))
    parts.push(serializeFixedLenHex(block.parentBeaconBlockRoot ?? '0x'.padEnd(66, '0'), 32))
    parts.push(serializeFixedLenHex(block.parentHash, 32))
    parts.push(serializeFixedLenHex(block.receiptsRoot, 32))
    parts.push(serializeFixedLenHex(block.sha3Uncles, 32))
    writeVariableBytes(serializeHex(block.size))
    parts.push(serializeFixedLenHex(block.stateRoot, 32))
    writeVariableBytes(serializeHex(block.timestamp))
    writeVariableBytes(serializeHex(block.totalDifficulty))
    parts.push(serializeFixedLenHex(block.transactionsRoot, 32))

    // Serialize uncles count and uncles
    writeVariableBytes(serializeNumber(block.uncles.length))
    for (const uncle of block.uncles) {
        writeVariableBytes(serializeHex(uncle))
    }

    // Serialize transactions count and transactions
    writeVariableBytes(serializeNumber(block.transactions.length))
    for (const tx of block.transactions) {
        parts.push(serializeFixedLenHex(tx.blockHash, 32))
        writeVariableBytes(serializeHex(tx.blockNumber))
        parts.push(serializeFixedLenHex(tx.from, 20))
        writeVariableBytes(serializeHex(tx.gas))
        writeVariableBytes(serializeHex(tx.gasPrice))
        writeVariableBytes(serializeHex(tx.maxFeePerGas ?? '0x0'))
        writeVariableBytes(serializeHex(tx.maxPriorityFeePerGas ?? '0x0'))
        parts.push(serializeFixedLenHex(tx.hash, 32))
        writeVariableBytes(serializeHex(tx.input))
        writeVariableBytes(serializeHex(tx.nonce))

        // Handle conditional 'to' field
        if (tx.to) {
            parts.push(Buffer.from([1])) // has 'to'
            parts.push(serializeFixedLenHex(tx.to, 20))
        } else {
            parts.push(Buffer.from([0])) // no 'to'
        }

        writeVariableBytes(serializeHex(tx.transactionIndex))
        writeVariableBytes(serializeHex(tx.value))
        writeVariableBytes(serializeHex(tx.type))

        // Serialize access list
        writeVariableBytes(serializeNumber(tx.accessList?.length ?? 0))
        for (const address of tx.accessList ?? []) {
            writeVariableBytes(serializeHex(address))
        }

        writeVariableBytes(serializeHex(tx.chainId))
        writeVariableBytes(serializeHex(tx.v))
        parts.push(serializeFixedLenHex(tx.r, 32))
        parts.push(serializeFixedLenHex(tx.s, 32))
        writeVariableBytes(serializeHex(tx.yParity ?? '0x0'))
    }

    // Calculate total length and create result buffer
    // Concatenate all parts into a single Buffer
    return Buffer.concat(parts)
}

function decodeBlockCustom(data: Uint8Array): Block {
    let offset = 0

    const readVariableBytes = (): Uint8Array => {
        const length = data[offset]
        offset++
        const result = data.slice(offset, offset + length)
        offset += length
        return result
    }

    const readFixedBytes = (length: number): Uint8Array => {
        const result = data.slice(offset, offset + length)
        offset += length
        return result
    }

    const readVariableHex = (): string => {
        return deserializeHex(readVariableBytes())
    }

    const readFixedHex = (length: number): string => {
        return deserializeFixedLenHex(readFixedBytes(length))
    }

    const readNumber = (): number => {
        return deserializeNumber(readVariableBytes())
    }

    // Decode block fields
    const block: Block = {
        baseFeePerGas: readVariableHex(),
        blobGasUsed: readVariableHex(),
        blockGasCost: readVariableHex(),
        difficulty: readVariableHex(),
        excessBlobGas: readVariableHex(),
        extraData: readVariableHex(),
        gasLimit: readVariableHex(),
        gasUsed: readVariableHex(),
        hash: readFixedHex(32),
        logsBloom: readFixedHex(256),
        miner: readFixedHex(20),
        mixHash: readFixedHex(32),
        nonce: readFixedHex(8),
        number: readVariableHex(),
        parentBeaconBlockRoot: readFixedHex(32),
        parentHash: readFixedHex(32),
        receiptsRoot: readFixedHex(32),
        sha3Uncles: readFixedHex(32),
        size: readVariableHex(),
        stateRoot: readFixedHex(32),
        timestamp: readVariableHex(),
        totalDifficulty: readVariableHex(),
        transactionsRoot: readFixedHex(32),
        uncles: [],
        transactions: []
    }

    // Decode uncles
    const uncleCount = readNumber()
    for (let i = 0; i < uncleCount; i++) {
        block.uncles.push(readVariableHex())
    }

    // Decode transactions
    const txCount = readNumber()
    for (let i = 0; i < txCount; i++) {
        const transaction: any = {
            blockHash: readFixedHex(32),
            blockNumber: readVariableHex(),
            from: readFixedHex(20),
            gas: readVariableHex(),
            gasPrice: readVariableHex(),
            maxFeePerGas: readVariableHex(),
            maxPriorityFeePerGas: readVariableHex(),
            hash: readFixedHex(32),
            input: readVariableHex(),
            nonce: readVariableHex()
        }

        // Handle conditional 'to' field
        const hasTo = data[offset++]
        if (hasTo === 1) {
            transaction.to = readFixedHex(20)
        } else {
            transaction.to = null
        }

        transaction.transactionIndex = readVariableHex()
        transaction.value = readVariableHex()
        transaction.type = readVariableHex()

        // Decode access list
        const accessListLength = readNumber()
        transaction.accessList = []
        for (let j = 0; j < accessListLength; j++) {
            transaction.accessList.push(readVariableHex())
        }

        transaction.chainId = readVariableHex()
        transaction.v = readVariableHex()
        transaction.r = readFixedHex(32)
        transaction.s = readFixedHex(32)
        transaction.yParity = readVariableHex()

        block.transactions.push(transaction)
    }

    return block
}
