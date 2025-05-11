import { ClassicLevel } from "classic-level"

import { decode, encode } from 'cbor2';

export class ArchiverDB {
    private db: ClassicLevel<string, Uint8Array>;

    constructor(folder: string) {
        this.db = new ClassicLevel<string, Uint8Array>(folder, {
            valueEncoding: 'buffer',
            // Optimal block size - 16KB is recommended for general workloads
            // Larger block size (16KB) improves space efficiency and reduces index size
            blockSize: 256 * 1024,
            // Enable compression for better space efficiency
            compression: true,
            // Set maximum open files to -1 to keep all files open and avoid table cache lookups
            maxOpenFiles: -1,
            // Increase write buffer size for better write performance
            writeBufferSize: 64 * 1024 * 1024,  // 64MB
        })
    }

    async save(key: string, value: unknown) {
        const buffer = Buffer.from(encode(value))
        await this.db.put(key, buffer)
    }

    async load<Type = unknown>(key: string): Promise<Type> {
        const buffer = await this.db.get(key)
        if (!buffer) throw new Error(`Key not found: ${key}`)
        return decode(buffer) as Type
    }

    async close() {
        await this.db.close()
    }
}
