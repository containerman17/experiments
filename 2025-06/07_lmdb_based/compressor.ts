import { Buffer } from 'node:buffer';
import * as zlib from 'node:zlib';
import { compress as lz4Compress, uncompress as lz4Uncompress } from 'lz4-napi';

const FLAG_UNCOMPRESSED = 0x00;
const FLAG_ZSTD_JSON = 0x01;
const FLAG_LZ4_JSON = 0x02;
const DEFAULT_COMPRESSION_LEVEL = 1;

/**
 * Compresses a buffer with ZSTD and adds a flag byte
 */
async function compressBuffer(buffer: Buffer, level: number = DEFAULT_COMPRESSION_LEVEL): Promise<Buffer> {
    // If level 0, skip compression
    if (level === 0) {
        const result = Buffer.alloc(buffer.length + 1);
        result[0] = FLAG_UNCOMPRESSED;
        buffer.copy(result, 1);
        return result;
    }

    // Compress with node:zlib
    const compressedBuffer = await nodeZstdCompress(buffer, level);

    // Prepend flag byte - use concat for efficiency
    return Buffer.concat([Buffer.from([FLAG_ZSTD_JSON]), compressedBuffer]);
}

/**
 * Compresses a buffer with LZ4 and adds a flag byte
 */
async function compressBufferLZ4(buffer: Buffer): Promise<Buffer> {
    // Compress with LZ4
    const compressedBuffer = await lz4Compress(buffer);

    // Prepend flag byte - use concat for efficiency
    return Buffer.concat([Buffer.from([FLAG_LZ4_JSON]), compressedBuffer]);
}

/**
 * Decompresses a buffer that was compressed with compressBuffer
 */
async function decompressBuffer(data: Buffer): Promise<Buffer> {
    const flag = data[0];
    const payload = data.subarray(1);

    if (flag === FLAG_UNCOMPRESSED) {
        return payload;
    } else if (flag === FLAG_ZSTD_JSON) {
        return nodeZstdDecompress(payload);
    } else if (flag === FLAG_LZ4_JSON) {
        return lz4Uncompress(payload);
    } else {
        throw new Error(`Unknown compression flag: ${flag}`);
    }
}

/**
 * Encodes data using JSON encoding and compresses it with ZSTD (via node:zlib)
 */
export async function compress(data: any, level: number = DEFAULT_COMPRESSION_LEVEL): Promise<Buffer> {
    // First encode the data with JSON
    const jsonEncoded = Buffer.from(JSON.stringify(data), 'utf8');

    // Compress the encoded buffer
    return compressBuffer(jsonEncoded, level);
}

/**
 * Encodes data using JSON encoding and compresses it with LZ4
 */
export async function compressLZ4(data: any): Promise<Buffer> {
    // First encode the data with JSON
    const jsonEncoded = Buffer.from(JSON.stringify(data), 'utf8');

    // Compress the encoded buffer with LZ4
    return compressBufferLZ4(jsonEncoded);
}

/**
 * Compresses raw buffer data with ZSTD (no JSON encoding)
 */
export async function compressRaw(data: Buffer, level: number = DEFAULT_COMPRESSION_LEVEL): Promise<Buffer> {
    return compressBuffer(data, level);
}

/**
 * Compresses raw buffer data with LZ4 (no JSON encoding)
 */
export async function compressRawLZ4(data: Buffer): Promise<Buffer> {
    return compressBufferLZ4(data);
}

/**
 * Decodes data that was encoded with the compress function
 */
export async function decompress<T>(data: Buffer): Promise<T> {
    // Decompress the buffer
    const decompressedBuf = await decompressBuffer(data);

    // Decode JSON data
    return JSON.parse(decompressedBuf.toString('utf8')) as T;
}

/**
 * Decompresses raw buffer data (no JSON decoding)
 */
export async function decompressRaw(data: Buffer): Promise<Buffer> {
    return decompressBuffer(data);
}

/**
 * Compresses a Buffer using Node.js ZSTD.
 */
async function nodeZstdCompress(dataBuffer: Buffer, level: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        const compressionStream = zlib.createZstdCompress({
            params: {
                [zlib.constants.ZSTD_c_compressionLevel]: level,
                [zlib.constants.ZSTD_c_checksumFlag]: 1,
            },
        });

        compressionStream.on('data', (chunk: Buffer) => chunks.push(chunk));
        compressionStream.on('end', () => resolve(Buffer.concat(chunks)));
        compressionStream.on('error', reject);

        compressionStream.end(dataBuffer);
    });
}

/**
 * Decompresses a Buffer using Node.js ZSTD.
 */
async function nodeZstdDecompress(dataBuffer: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        const decompressionStream = zlib.createZstdDecompress();

        decompressionStream.on('data', (chunk: Buffer) => chunks.push(chunk));
        decompressionStream.on('end', () => resolve(Buffer.concat(chunks)));
        decompressionStream.on('error', reject);

        decompressionStream.end(dataBuffer);
    });
}
