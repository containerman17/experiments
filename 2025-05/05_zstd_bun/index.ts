import { compress, decompress } from "@yu7400ki/zstd-wasm";
import * as fs from 'fs';
import * as path from 'path';

console.log(">> Start @yu7400ki/zstd-wasm compression");
const main = async () => {
    const files = await fs.promises.readdir('/tmp');
    const cborFiles = files.filter(file => file.startsWith('block-') && file.endsWith('.cbor')).map(file => path.join('/tmp', file));

    if (cborFiles.length === 0) {
        console.log("No matching CBOR files found in /tmp.");
        return;
    }

    console.log(`Found ${cborFiles.length} CBOR files to compress using @yu7400ki/zstd-wasm.`);

    let totalOriginalSize = 0;
    let totalCompressedSize = 0;

    console.time('Total compression time (@yu7400ki/zstd-wasm)');

    const compressionPromises = cborFiles.map(async (filePath) => {
        try {
            const fileBuffer = await fs.promises.readFile(filePath);
            const originalSize = fileBuffer.length;

            if (originalSize === 0) {
                // console.log(`${path.basename(filePath)}: original size 0 bytes. Skipping.`);
                return { originalSize: 0, compressedSize: 0 }; // Still return sizes for aggregation
            }

            // console.time(`Compressing ${path.basename(filePath)}`);
            const compressedData = await compress(fileBuffer, 18); // Assuming compression level 18
            // console.timeEnd(`Compressing ${path.basename(filePath)}`);

            const compressedSize = compressedData.length;
            // const ratio = originalSize / compressedSize;
            // console.log(`${path.basename(filePath)}: original size ${originalSize} bytes, compressed size ${compressedSize} bytes. Compression ratio: ${ratio.toFixed(2)}x`);
            return { originalSize, compressedSize };
        } catch (error) {
            console.error(`Error processing ${filePath}:`, error);
            return { originalSize: 0, compressedSize: 0, error: (error as Error).message }; // Return 0 sizes on error to not affect ratio
        }
    });

    const results = await Promise.all(compressionPromises);
    console.timeEnd('Total compression time (@yu7400ki/zstd-wasm)');

    results.forEach(result => {
        if (result && !result.error) {
            totalOriginalSize += result.originalSize;
            totalCompressedSize += result.compressedSize;
        }
    });

    if (totalCompressedSize > 0) {
        const overallRatio = totalOriginalSize / totalCompressedSize;
        console.log(`Overall compression (@yu7400ki/zstd-wasm):`);
        console.log(`  Total original size: ${totalOriginalSize} bytes`);
        console.log(`  Total compressed size: ${totalCompressedSize} bytes`);
        console.log(`  Overall compression ratio: ${overallRatio.toFixed(2)}x`);
    } else if (totalOriginalSize > 0 && totalCompressedSize === 0) {
        console.log("Overall compression (@yu7400ki/zstd-wasm): All files were empty or resulted in zero compressed size (or only errors occurred).");
    } else {
        console.log("Overall compression (@yu7400ki/zstd-wasm): No data processed or all files were empty.");
    }
};

main().catch(console.error);
