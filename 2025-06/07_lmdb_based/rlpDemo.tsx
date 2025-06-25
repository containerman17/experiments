import { RLP } from '@ethereumjs/rlp'
import assert from 'assert'
import { bytesToHex, hexToBytes, concatBytes, utf8ToBytes } from '@noble/curves/abstract/utils';
import { Block } from './blockFetcher/evmTypes';


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

import block from './blockFetcher/data/block.example.json'
const encoded = encodeBlock(block)

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

console.log(JSON.stringify(block))
console.log(JSON.stringify(restoredBlock))


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
import { compress } from './compressor'

async function compareCompression() {
    console.log('\n=== COMPRESSION COMPARISON ===')

    // Original data sizes
    const jsonData = JSON.stringify(block)
    const rlpData = encoded

    console.log('Original sizes:')
    console.log('  JSON size:', jsonData.length, 'bytes')
    console.log('  RLP size:', rlpData.length, 'bytes')
    console.log('  RLP vs JSON ratio:', (rlpData.length / jsonData.length * 100).toFixed(1) + '%')

    // Test compression levels 1 and 18
    for (const level of [1, 18]) {
        console.log(`\nCompression level ${level}:`)

        // Compress JSON
        const compressedJson = await compress(block, level)
        console.log('  JSON compressed:', compressedJson.length, 'bytes')
        console.log('  JSON compression ratio:', (compressedJson.length / jsonData.length * 100).toFixed(1) + '%')

        // Compress RLP (need to convert to object that compress function can handle)
        const rlpAsBuffer = Buffer.from(rlpData)
        const compressedRlp = await compress(Array.from(rlpAsBuffer), level)
        console.log('  RLP compressed:', compressedRlp.length, 'bytes')
        console.log('  RLP compression ratio:', (compressedRlp.length / rlpData.length * 100).toFixed(1) + '%')

        console.log('  Best format: RLP compressed is', (compressedRlp.length / compressedJson.length * 100).toFixed(1) + '% of JSON compressed')
    }
}

compareCompression().catch(console.error)
