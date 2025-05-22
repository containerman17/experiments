import { readFileSync } from 'node:fs';
import { decode } from 'cbor2';
import { encode as cborEncode } from 'cbor2';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import { Buffer } from 'node:buffer';
import { compressBuffer } from './compressor';
const COMPRESSION_LEVEL = 18;
const TEST_FILE = './compression_bench.cbor2';
const ITERATIONS = 5;

// Helper to convert BigInts to strings in an object for JSON serialization
function replaceBigInts(obj: any): any {
    if (obj === null || obj === undefined) {
        return obj;
    }

    if (typeof obj === 'bigint') {
        return obj.toString();
    }

    if (Array.isArray(obj)) {
        return obj.map(replaceBigInts);
    }

    if (typeof obj === 'object') {
        const result: Record<string, any> = {};
        for (const [key, value] of Object.entries(obj)) {
            result[key] = replaceBigInts(value);
        }
        return result;
    }

    return obj;
}

async function runBenchmark() {
    console.log('Decoding test data from', TEST_FILE);
    const encodedData = readFileSync(TEST_FILE);
    const originalSize = encodedData.length;
    const testData = decode(encodedData);

    console.log('Test data size (original):', originalSize, 'bytes');

    // Prepare encoders
    const encoders = [
        {
            name: 'CBOR2',
            encode: (data: any) => Buffer.from(cborEncode(data))
        },
        {
            name: 'JSON with BigInt->String',
            encode: (data: any) => Buffer.from(JSON.stringify(replaceBigInts(data)))
        },
        {
            name: 'MessagePack',
            encode: (data: any) => Buffer.from(msgpackEncode(data))
        }
    ];

    const results: Record<string, {
        encodeTime: number,
        compressTime: number,
        encodedSize: number,
        compressedSize: number,
        ratio: number
    }> = {};

    // Run benchmarks
    for (const encoder of encoders) {
        let totalEncodeTime = 0;
        let totalCompressTime = 0;
        let encodedBuffer: Buffer | null = null;
        let compressedBuffer: Buffer | null = null;

        for (let i = 0; i < ITERATIONS; i++) {
            // Measure encoding time
            const encodeStart = performance.now();
            encodedBuffer = encoder.encode(testData);
            const encodeEnd = performance.now();

            // Measure compression time
            const compressStart = performance.now();
            compressedBuffer = Buffer.from(await compressBuffer(encodedBuffer, COMPRESSION_LEVEL));
            const compressEnd = performance.now();

            totalEncodeTime += (encodeEnd - encodeStart);
            totalCompressTime += (compressEnd - compressStart);
        }

        // Calculate averages
        const avgEncodeTime = totalEncodeTime / ITERATIONS;
        const avgCompressTime = totalCompressTime / ITERATIONS;

        results[encoder.name] = {
            encodeTime: avgEncodeTime,
            compressTime: avgCompressTime,
            encodedSize: encodedBuffer!.length,
            compressedSize: compressedBuffer!.length,
            ratio: originalSize / compressedBuffer!.length
        };
    }

    // Print results
    console.log('\nBenchmark Results (avg of', ITERATIONS, 'runs):');
    console.log('═════════════════════════════════════════════════════════════════════');
    console.log('Format            │ Encode Time │ Compress Time │ Size Before │ Size After │ Ratio');
    console.log('───────────────────┼─────────────┼───────────────┼─────────────┼────────────┼──────');

    for (const [name, result] of Object.entries(results)) {
        console.log(
            `${name.padEnd(18)} │ ${result.encodeTime.toFixed(2).padStart(9)}ms │ ${result.compressTime.toFixed(2).padStart(11)}ms │ ${result.encodedSize.toLocaleString().padStart(10)} │ ${result.compressedSize.toLocaleString().padStart(9)} │ ${result.ratio.toFixed(2)}x`
        );
    }
    console.log('═════════════════════════════════════════════════════════════════════');
}

runBenchmark().catch(console.error);
