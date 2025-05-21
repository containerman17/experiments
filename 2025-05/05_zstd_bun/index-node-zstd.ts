import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'node:zlib';
import { Buffer } from "node:buffer";
console.log(">> Start node:zlib compression");

const COMPRESSION_LEVEL = 18;

/**
 * Compresses a Buffer using Node.js ZSTD.
 */
async function nodeZstdCompress(dataBuffer: Buffer, level: number = COMPRESSION_LEVEL): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        const compressionStream = zlib.createZstdCompress({
            params: {
                [zlib.constants.ZSTD_c_compressionLevel]: level,
                [zlib.constants.ZSTD_c_checksumFlag]: 1, // Enable checksum, as in the example
            },
        });

        compressionStream.on('data', (chunk: Buffer) => chunks.push(chunk));
        compressionStream.on('end', () => resolve(Buffer.concat(chunks)));
        compressionStream.on('error', reject);

        // Write data to the compression stream and signal that no more data will be written
        compressionStream.end(dataBuffer);
    });
}

const main = async () => {
    const tempDir = '/tmp';
    let files: string[];
    try {
        files = await fs.promises.readdir(tempDir);
    } catch (error: any) {
        console.error(`Error reading directory ${tempDir}:`, error.message);
        return;
    }

    const cborFiles = files
        .filter(file => file.startsWith('block-') && file.endsWith('.cbor'))
        .map(file => path.join(tempDir, file));

    if (cborFiles.length === 0) {
        console.log(`No matching files (block-*.cbor) found in ${tempDir}.`);
        return;
    }

    console.log(`Found ${cborFiles.length} files in ${tempDir} to compress using node:zlib.`);

    let totalOriginalSize = 0;
    let totalCompressedSize = 0;

    console.time('Total compression time (node:zlib)');

    const compressionPromises = cborFiles.map(async (filePath) => {
        try {
            const fileBuffer = await fs.promises.readFile(filePath);
            const originalSize = fileBuffer.length;

            if (originalSize === 0) {
                // console.log(`${path.basename(filePath)} (node:zlib): original size 0 bytes. Skipping compression.`);
                return { originalSize: 0, compressedSize: 0 };
            }

            // console.time(`Compressing ${path.basename(filePath)} with node:zlib`);
            const compressedData = await nodeZstdCompress(fileBuffer, COMPRESSION_LEVEL);
            // console.timeEnd(`Compressing ${path.basename(filePath)} with node:zlib`);

            const compressedSize = compressedData.length;
            // console.log(`${path.basename(filePath)} (node:zlib): original size ${originalSize} bytes, compressed size ${compressedSize} bytes. Compression ratio: ${ratio.toFixed(2)}x`);
            return { originalSize, compressedSize };
        } catch (error: any) {
            console.error(`Error processing ${filePath} with node:zlib: ${error.message}`);
            return { originalSize: 0, compressedSize: 0, error: error.message };
        }
    });

    const results = await Promise.all(compressionPromises);
    console.timeEnd('Total compression time (node:zlib)');

    results.forEach(result => {
        if (result && !result.error) {
            totalOriginalSize += result.originalSize;
            totalCompressedSize += result.compressedSize;
        }
    });

    if (totalCompressedSize > 0) {
        const overallRatio = totalOriginalSize / totalCompressedSize;
        console.log("Overall compression (node:zlib):");
        console.log(`  Total original size: ${totalOriginalSize} bytes`);
        console.log(`  Total compressed size: ${totalCompressedSize} bytes`);
        console.log(`  Overall compression ratio: ${overallRatio.toFixed(2)}x`);
    } else if (totalOriginalSize > 0 && totalCompressedSize === 0) {
        console.log("Overall compression (node:zlib): All files were empty or resulted in zero compressed size (or only errors occurred).");
    } else {
        console.log("Overall compression (node:zlib): No data processed or all files were empty.");
    }
};

main().catch(err => {
    console.error("Unhandled error in main execution (node:zlib script):", err.message);
    process.exit(1);
});
