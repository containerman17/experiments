import { createClient } from '@clickhouse/client';
import type { ClickHouseClient } from '@clickhouse/client';
import { promises as fs } from 'fs';
import path from 'path';

export interface LogRow {
    block_time: number;
    block_number: number;
    block_hash: string;
    contract_address: string;
    topic0: string;
    topic1: string;
    topic2: string;
    topic3: string;
    data: string;
    tx_hash: string;
    log_index: number;
    tx_index: number;
    block_date: string;
    tx_from: string;
    tx_to: string;
}

export class ClickHouseWriter {
    private client: ClickHouseClient;
    private readonly database: string;

    constructor(config: { host: string; port?: number; database?: string; username?: string; password?: string }) {
        this.database = config.database || 'default';
        this.client = createClient({
            url: config.host,
            database: this.database,
            username: config.username,
            password: config.password,
        });
    }

    async initialize(): Promise<void> {
        const schemaPath = path.join(process.cwd(), 'clickhouse', 'structure.sql');
        const schema = await fs.readFile(schemaPath, 'utf-8');

        // Make it idempotent by adding IF NOT EXISTS
        const idempotentSchema = schema.replace('CREATE TABLE logs', 'CREATE TABLE IF NOT EXISTS logs');

        await this.client.exec({ query: idempotentSchema });
    }

    async getLastLogBlockNumber(): Promise<number> {
        const result = await this.client.query({
            query: 'SELECT max(block_number) as max_block FROM logs',
            format: 'JSONEachRow',
        });

        const rows = await result.json<{ max_block: number | string | null }>();
        if (rows.length === 0 || rows[0].max_block === null || rows[0].max_block === 0 || rows[0].max_block === '0') {
            return -1;
        }
        return Number(rows[0].max_block);
    }

    async insertLogs(logs: LogRow[]): Promise<void> {
        if (logs.length === 0) return;

        await this.client.insert({
            table: 'logs',
            values: logs,
            format: 'JSONEachRow',
        });
    }

    async close(): Promise<void> {
        await this.client.close();
    }
}

