import fs from 'fs';
import path from 'path';
import { loadFromDb, db } from './db';
import { encode } from 'cbor2';

async function calculateCompression() {
    console.log('Calculating database compression statistics...');

    // Get all keys from the database
    const keys: string[] = [];
    for await (const key of db.keys()) {
        keys.push(key.toString());
    }

    console.log(`Found ${keys.length} items in database`);

    // Calculate total size of CBOR objects in memory
    let totalCborSize = 0;

    for (const key of keys) {
        try {
            const data = await loadFromDb(key);
            // Use the same CBOR encoding as the db.ts file
            const buffer = Buffer.from(encode(data));
            totalCborSize += buffer.length;
        } catch (error) {
            console.error(`Error processing key: ${key}`, error);
        }
    }

    // Calculate the total size of the database on disk
    const dbPath = path.resolve('data/archive');
    let totalDiskSize = 0;

    function calculateDirSize(dirPath: string): number {
        let size = 0;
        const files = fs.readdirSync(dirPath);

        for (const file of files) {
            const filePath = path.join(dirPath, file);
            const stats = fs.statSync(filePath);

            if (stats.isDirectory()) {
                size += calculateDirSize(filePath);
            } else {
                size += stats.size;
            }
        }

        return size;
    }

    totalDiskSize = calculateDirSize(dbPath);

    // Calculate compression ratio
    const compressionRatio = (totalCborSize / totalDiskSize) * 100;

    console.log(`Total CBOR data size: ${formatBytes(totalCborSize)}`);
    console.log(`Total database size on disk: ${formatBytes(totalDiskSize)}`);
    console.log(`Compression ratio: ${compressionRatio.toFixed(2)}%`);
    console.log(`Storage efficiency: ${(100 - compressionRatio).toFixed(2)}% space saved`);
}

function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Run the calculation
calculateCompression().catch(console.error);
