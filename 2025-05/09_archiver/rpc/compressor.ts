import { encode, decode } from 'cbor2';
import { compress as zstdCompress, decompress as zstdDecompress } from '@yu7400ki/zstd-wasm';
import { Buffer } from 'node:buffer';

const FLAG_UNCOMPRESSED = 0x00;
const FLAG_ZSTD_WASM = 0x01;
const DEFAULT_COMPRESSION_LEVEL = 18;

/**
 * Compresses a buffer with ZSTD and adds a flag byte
 */
export async function compressBuffer(buffer: Buffer, level: number = DEFAULT_COMPRESSION_LEVEL): Promise<Buffer> {
    // If level 0, skip compression
    if (level === 0) {
        const result = Buffer.alloc(buffer.length + 1);
        result[0] = FLAG_UNCOMPRESSED;
        buffer.copy(result, 1);
        return result;
    }

    // Compress with zstd-wasm
    const compressedData = await zstdCompress(buffer, level);
    const compressedBuffer = Buffer.from(compressedData);

    // Prepend flag byte
    const result = Buffer.alloc(compressedBuffer.length + 1);
    result[0] = FLAG_ZSTD_WASM;
    compressedBuffer.copy(result, 1);

    return result;
}

/**
 * Decompresses a buffer that was compressed with compressBuffer
 */
export async function decompressBuffer(data: Buffer): Promise<Buffer> {
    const flag = data[0];
    const payload = data.subarray(1);

    if (flag === FLAG_UNCOMPRESSED) {
        return Buffer.from(payload);
    } else if (flag === FLAG_ZSTD_WASM) {
        const decompressedData = await zstdDecompress(payload);
        return Buffer.from(decompressedData);
    } else {
        throw new Error(`Unknown compression flag: ${flag}`);
    }
}

/**
 * Encodes data using CBOR encoding and compresses it with ZSTD (via @yu7400ki/zstd-wasm)
 */
export async function compress(data: any, level: number = DEFAULT_COMPRESSION_LEVEL): Promise<Buffer> {
    // First encode the data with CBOR
    const cborEncoded = Buffer.from(encode(data));

    // Compress the encoded buffer
    return compressBuffer(cborEncoded, level);
}

/**
 * Decodes data that was encoded with the compress function
 */
export async function decompress<T>(data: Buffer): Promise<T> {
    // Decompress the buffer
    const decompressedBuf = await decompressBuffer(data);

    // Decode CBOR data
    return decode(decompressedBuf) as T;
}
