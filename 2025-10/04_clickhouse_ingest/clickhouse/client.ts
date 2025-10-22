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

export interface BlockRow {
    time: number;
    timestamp: number;
    number: number;
    gas_limit: number;
    gas_used: number;
    difficulty: number;
    total_difficulty: number;
    size: number;
    base_fee_per_gas: number | null;
    hash: string;
    parent_hash: string;
    miner: string;
    nonce: string;
    date: string;
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
        const idempotentSchema = schema
            .replace('CREATE TABLE logs', 'CREATE TABLE IF NOT EXISTS logs')
            .replace('CREATE TABLE blocks', 'CREATE TABLE IF NOT EXISTS blocks');

        // Split by semicolon and execute each statement separately
        const statements = idempotentSchema
            .split(';')
            .map(s => s.trim())
            .filter(s => s.length > 0);

        for (const statement of statements) {
            await this.client.exec({ query: statement });
        }
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

    async getLastBlockNumberFromBlocks(): Promise<number> {
        const result = await this.client.query({
            query: 'SELECT max(number) as max_block FROM blocks',
            format: 'JSONEachRow',
        });

        const rows = await result.json<{ max_block: number | string | null }>();
        if (rows.length === 0 || rows[0].max_block === null || rows[0].max_block === 0 || rows[0].max_block === '0') {
            return -1;
        }
        return Number(rows[0].max_block);
    }

    async getLastBlockNumber(): Promise<{ min: number; logs: number; blocks: number }> {
        const [logsLast, blocksLast] = await Promise.all([
            this.getLastLogBlockNumber(),
            this.getLastBlockNumberFromBlocks(),
        ]);

        return {
            min: Math.min(logsLast, blocksLast),
            logs: logsLast,
            blocks: blocksLast,
        };
    }

    async insertLogs(logs: LogRow[]): Promise<void> {
        if (logs.length === 0) return;

        await this.client.insert({
            table: 'logs',
            values: logs,
            format: 'JSONEachRow',
        });
    }

    async insertBlocks(blocks: BlockRow[]): Promise<void> {
        if (blocks.length === 0) return;

        await this.client.insert({
            table: 'blocks',
            values: blocks,
            format: 'JSONEachRow',
        });
    }

    async close(): Promise<void> {
        await this.client.close();
    }
}

