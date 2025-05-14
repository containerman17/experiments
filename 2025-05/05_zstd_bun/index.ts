import { compress, decompress } from "@yu7400ki/zstd-wasm";
import * as fs from 'fs';


const readAllJsFiles = async () => {
    const jsFiles: string[] = [];

    const walkDir = async (dir: string) => {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = `${dir}/${entry.name}`;

            if (entry.isDirectory()) {
                await walkDir(fullPath);
            } else if (entry.name.endsWith('.js')) {
                const content = await fs.promises.readFile(fullPath, 'utf-8');
                jsFiles.push(content);
            }
        }
    };

    await walkDir('../04_hoarder/node_modules');
    return jsFiles.join('\n');
};

const data = await readAllJsFiles();
const textEncoder = new TextEncoder();
const dataBuffer = textEncoder.encode(data);
console.time('compress');
const compressed = await compress(dataBuffer, 18);
console.timeEnd('compress');
console.time('decompress');
const decompressed = await decompress(compressed);
console.timeEnd('decompress');
console.log(`${compressed.length} bytes compressed to ${decompressed.length} bytes. Compression ratio: ${decompressed.length / compressed.length}x`);
