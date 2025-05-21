import { encode, decode } from 'cbor2';
import { compress as zstdCompress, decompress as zstdDecompress } from '@yu7400ki/zstd-wasm';
import { Buffer } from 'node:buffer';

const FLAG_UNCOMPRESSED = 0x00;
const FLAG_ZSTD_WASM = 0x01;
const DEFAULT_COMPRESSION_LEVEL = 18;

/**
 * Encodes data using CBOR encoding and compresses it with ZSTD (via @yu7400ki/zstd-wasm)
 */
export async function compress(data: any, level: number = DEFAULT_COMPRESSION_LEVEL): Promise<Buffer> {
    // First encode the data with CBOR
    const cborEncoded = Buffer.from(encode(data));

    // If level 0, skip compression
    if (level === 0) {
        const result = Buffer.alloc(cborEncoded.length + 1);
        result[0] = FLAG_UNCOMPRESSED;
        cborEncoded.copy(result, 1);
        return result;
    }

    // Compress with zstd-wasm
    const compressedData = await zstdCompress(cborEncoded, level);
    const compressedBuffer = Buffer.from(compressedData);

    // Prepend flag byte
    const result = Buffer.alloc(compressedBuffer.length + 1);
    result[0] = FLAG_ZSTD_WASM;
    compressedBuffer.copy(result, 1);

    return result;
}

/**
 * Decodes data that was encoded with the compress function
 */
export async function decompress<T>(data: Buffer): Promise<T> {
    const flag = data[0];
    const payload = data.subarray(1);

    let decompressedBuf: Buffer;

    if (flag === FLAG_UNCOMPRESSED) {
        decompressedBuf = Buffer.from(payload);
    } else if (flag === FLAG_ZSTD_WASM) {
        const decompressedData = await zstdDecompress(payload);
        decompressedBuf = Buffer.from(decompressedData);
    } else {
        throw new Error(`Unknown compression flag: ${flag}`);
    }

    // Decode CBOR data
    return decode(decompressedBuf) as T;
}
