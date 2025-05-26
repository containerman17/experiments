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
    private stmtCache = new Map<string, SQLite.Statement>();

    constructor(db: SQLite.Database) {
        this.db = db;
    }

    private prepareCached(sql: string): SQLite.Statement {
        let stmt = this.stmtCache.get(sql);
        if (!stmt) {
            stmt = this.db.prepare(sql);
            this.stmtCache.set(sql, stmt);
        }
        return stmt;
    }

    insertTxBlockLookup(txHash: Hex, blockNumber: number): void {
        const SQL = `INSERT INTO tx_block_lookup (hash_to_block) VALUES (?) ON CONFLICT(hash_to_block) DO NOTHING`;
        const txHashBytes = toBytes(txHash);
        const lookupKey = Buffer.from([...txHashBytes.slice(0, 5), ...toBytes(blockNumber)]);
        this.prepareCached(SQL).run(lookupKey);
    }

    updateConfig(key: string, value: string): void {
        const SQL = `UPDATE configs SET value = ? WHERE key = ?`;
        this.prepareCached(SQL).run(value, key);
    }

    getConfig(key: string): string | null {
        const SQL = `SELECT value FROM configs WHERE key = ?`;
        const result = this.prepareCached(SQL).get(key) as { value: string } | undefined;
        return result?.value || null;
    }

    getTxLookupByPrefix(txHash: Hex): number[] {
        const SQL = `SELECT hash_to_block FROM tx_block_lookup WHERE hex(hash_to_block) LIKE ?`;
        const fullTxHashBytes = toBytes(txHash);
        const prefixBytes = fullTxHashBytes.slice(0, 5);
        const prefixHex = Buffer.from(prefixBytes).toString('hex');

        const lookupKeyRows = this.prepareCached(SQL).all(`${prefixHex}%`) as { hash_to_block: Buffer }[];

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

    recordTxCount(txCount: number, blockTimestamp: number): void {
        const hourBucket = Math.floor(blockTimestamp / 3600);
        const dayBucket = Math.floor(blockTimestamp / 86400);

        const HOURLY_SQL = `INSERT INTO tx_counts_hourly (hour_bucket, tx_count) VALUES (?, ?) ON CONFLICT(hour_bucket) DO UPDATE SET tx_count = tx_count + excluded.tx_count`;
        const DAILY_SQL = `INSERT INTO tx_counts_daily (day_bucket, tx_count) VALUES (?, ?) ON CONFLICT(day_bucket) DO UPDATE SET tx_count = tx_count + excluded.tx_count`;

        this.prepareCached(HOURLY_SQL).run(hourBucket, txCount);
        this.prepareCached(DAILY_SQL).run(dayBucket, txCount);
    }

    getHourlyTxCount(limit: number = 10): Array<{ timestamp: number; txCount: number }> {
        const SQL = `SELECT hour_bucket, tx_count FROM tx_counts_hourly WHERE hour_bucket >= ? ORDER BY hour_bucket DESC LIMIT ?`;
        const now = Math.floor(Date.now() / 1000);
        const currentBucket = Math.floor(now / 3600);
        const startBucket = currentBucket - limit + 1;

        const rows = this.prepareCached(SQL).all(startBucket, limit) as Array<{ hour_bucket: number; tx_count: number }>;

        // Create a map for quick lookup
        const dataMap = new Map<number, number>();
        for (const row of rows) {
            dataMap.set(row.hour_bucket, row.tx_count);
        }

        // Fill in missing buckets with zeros
        const result: Array<{ timestamp: number; txCount: number }> = [];
        for (let bucket = startBucket; bucket <= currentBucket; bucket++) {
            const txCount = dataMap.get(bucket) || 0;
            result.push({
                timestamp: bucket * 3600,
                txCount: txCount
            });
        }

        return result.slice(-limit);
    }

    getDailyTxCount(limit: number = 10): Array<{ timestamp: number; txCount: number }> {
        const SQL = `SELECT day_bucket, tx_count FROM tx_counts_daily WHERE day_bucket >= ? ORDER BY day_bucket DESC LIMIT ?`;
        const now = Math.floor(Date.now() / 1000);
        const currentBucket = Math.floor(now / 86400);
        const startBucket = currentBucket - limit + 1;

        const rows = this.prepareCached(SQL).all(startBucket, limit) as Array<{ day_bucket: number; tx_count: number }>;

        // Create a map for quick lookup
        const dataMap = new Map<number, number>();
        for (const row of rows) {
            dataMap.set(row.day_bucket, row.tx_count);
        }

        // Fill in missing buckets with zeros
        const result: Array<{ timestamp: number; txCount: number }> = [];
        for (let bucket = startBucket; bucket <= currentBucket; bucket++) {
            const txCount = dataMap.get(bucket) || 0;
            result.push({
                timestamp: bucket * 86400,
                txCount: txCount
            });
        }

        return result.slice(-limit);
    }

    transaction<T>(fn: () => T): T {
        return this.db.transaction(fn)();
    }

    // Expose the raw database for complex queries like in IndexerAPI
    getRawDb(): SQLite.Database {
        return this.db;
    }
}
