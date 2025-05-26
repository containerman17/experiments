import SQLite from "better-sqlite3";
import * as fs from 'node:fs';
import * as path from 'node:path';
import { toBytes, fromBytes } from 'viem';
import type { Hex, Transaction } from 'viem';

const schema = `
PRAGMA page_size = 4096;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = OFF;
PRAGMA cache_size = -64000;
PRAGMA wal_autocheckpoint = 10000;
PRAGMA checkpoint_fullfsync = OFF;

CREATE TABLE IF NOT EXISTS tx_block_lookup (
    hash_to_block BLOB PRIMARY KEY
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS configs (
    key TEXT PRIMARY KEY, 
    value TEXT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS stats (
    frequency TEXT NOT NULL,
    bucket INTEGER NOT NULL,
    metric TEXT NOT NULL,
    submetric TEXT NOT NULL DEFAULT '',
    value INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (frequency, bucket, metric, submetric)
) WITHOUT ROWID;

INSERT OR IGNORE INTO configs (key, value) VALUES ('last_processed_block', '-1');
`

export function initializeDatabase(blockchainID: string): SQLite.Database {
    const dbPath = `./data/${blockchainID}/index.sqlite`;
    const db = new SQLite(dbPath);

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

        const STATS_SQL = `INSERT INTO stats (frequency, bucket, metric, submetric, value) VALUES (?, ?, ?, ?, ?) ON CONFLICT(frequency, bucket, metric, submetric) DO UPDATE SET value = value + excluded.value`;

        this.prepareCached(STATS_SQL).run('1h', hourBucket, 'txCnt', '', txCount);
        this.prepareCached(STATS_SQL).run('1d', dayBucket, 'txCnt', '', txCount);
    }

    private getMetric(frequency: '1h' | '1d', metric: string, submetric: string, limit: number = 10): Array<{ timestamp: number; value: number }> {
        const SQL = `SELECT bucket, value FROM stats WHERE frequency = ? AND metric = ? AND submetric = ? AND bucket >= ? ORDER BY bucket DESC LIMIT ?`;
        const now = Math.floor(Date.now() / 1000);
        const bucketSize = frequency === '1h' ? 3600 : 86400;
        const currentBucket = Math.floor(now / bucketSize);
        const startBucket = currentBucket - limit + 1;

        const rows = this.prepareCached(SQL).all(frequency, metric, submetric, startBucket, limit) as Array<{ bucket: number; value: number }>;

        // Create a map for quick lookup
        const dataMap = new Map<number, number>();
        for (const row of rows) {
            dataMap.set(row.bucket, row.value);
        }

        // Fill in missing buckets with zeros
        const result: Array<{ timestamp: number; value: number }> = [];
        for (let bucket = startBucket; bucket <= currentBucket; bucket++) {
            const value = dataMap.get(bucket) || 0;
            result.push({
                timestamp: bucket * bucketSize,
                value: value
            });
        }

        return result.slice(-limit);
    }

    getTxCount(frequency: '1h' | '1d', limit: number = 10): Array<{ timestamp: number; value: number }> {
        return this.getMetric(frequency, 'txCnt', '', limit);
    }

    transaction<T>(fn: () => T): T {
        return this.db.transaction(fn)();
    }

    // Expose the raw database for complex queries like in IndexerAPI
    getRawDb(): SQLite.Database {
        return this.db;
    }

    getLastProcessedBlockNumber(): number {
        const lastProcessedBlock = this.getConfig('last_processed_block');
        return parseInt(lastProcessedBlock || '-1');
    }
}
