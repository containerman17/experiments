import SQLite from "better-sqlite3";
import * as fs from 'node:fs';
import * as path from 'node:path';
import { toBytes, fromBytes } from 'viem';
import type { Hex } from 'viem';

export function initializeDatabase(blockchainID: string): SQLite.Database {
    const dbPath = `./data/${blockchainID}/index.sqlite`;
    const db = new SQLite(dbPath);

    // Read and execute schema
    const schemaPath = path.join(process.cwd(), 'database', 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    db.exec(schema);

    return db;
}

export class Database {
    private db: SQLite.Database;
    private insertTxLookupStmt: SQLite.Statement;
    private updateConfigStmt: SQLite.Statement;
    private getConfigStmt: SQLite.Statement;
    private getTxLookupByPrefixStmt: SQLite.Statement;

    constructor(db: SQLite.Database) {
        this.db = db;
        this.insertTxLookupStmt = db.prepare('INSERT INTO tx_block_lookup (hash_to_block) VALUES (?) ON CONFLICT(hash_to_block) DO NOTHING');
        this.updateConfigStmt = db.prepare('UPDATE configs SET value = ? WHERE key = ?');
        this.getConfigStmt = db.prepare('SELECT value FROM configs WHERE key = ?');
        this.getTxLookupByPrefixStmt = db.prepare('SELECT hash_to_block FROM tx_block_lookup WHERE hex(hash_to_block) LIKE ?');
    }

    insertTxBlockLookup(txHash: Hex, blockNumber: number): void {
        const txHashBytes = toBytes(txHash);
        const lookupKey = Buffer.from([...txHashBytes.slice(0, 5), ...toBytes(blockNumber)]);
        this.insertTxLookupStmt.run(lookupKey);
    }

    updateConfig(key: string, value: string): void {
        this.updateConfigStmt.run(value, key);
    }

    getConfig(key: string): string | null {
        const result = this.getConfigStmt.get(key) as { value: string } | undefined;
        return result?.value || null;
    }

    getTxLookupByPrefix(txHash: Hex): number[] {
        const fullTxHashBytes = toBytes(txHash);
        const prefixBytes = fullTxHashBytes.slice(0, 5);
        const prefixHex = Buffer.from(prefixBytes).toString('hex');

        const lookupKeyRows = this.getTxLookupByPrefixStmt.all(`${prefixHex}%`) as { hash_to_block: Buffer }[];

        const blockNumbers: number[] = [];
        for (const row of lookupKeyRows) {
            const lookupKeyBlob = row.hash_to_block;
            // Ensure lookupKeyBlob is long enough (prefix + at least 1 byte for number)
            if (lookupKeyBlob.length > 5) {
                const blockNumberBytes = lookupKeyBlob.slice(5);
                try {
                    const blockNumber = fromBytes(blockNumberBytes, 'number');
                    blockNumbers.push(blockNumber);
                } catch (e) {
                    console.error(`Error parsing block number from lookup key ${lookupKeyBlob.toString('hex')}:`, e);
                }
            }
        }

        return blockNumbers;
    }

    transaction<T>(fn: () => T): T {
        return this.db.transaction(fn)();
    }

    // Expose the raw database for complex queries like in IndexerAPI
    getRawDb(): SQLite.Database {
        return this.db;
    }
}
