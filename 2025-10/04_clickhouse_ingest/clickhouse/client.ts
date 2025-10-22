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

export interface TransactionRow {
    block_time: number;
    block_number: number;
    value: string;
    gas_limit: number;
    gas_price: number;
    gas_used: number;
    max_fee_per_gas: number | null;
    max_priority_fee_per_gas: number | null;
    priority_fee_per_gas: number | null;
    nonce: number;
    index: number;
    success: number;
    from: string;
    to: string | null;
    block_hash: string;
    data: string;
    hash: string;
    type: number;
    access_list: Array<[string, string[]]>;
    block_date: string;
}

export interface TraceRow {
    block_time: number;
    block_number: number;
    value: string;
    gas: number;
    gas_used: number;
    net_gas_used: number;
    block_hash: string;
    success: number;
    tx_index: number;
    sub_traces: number;
    error: string | null;
    tx_success: number;
    tx_hash: string;
    from: string;
    to: string | null;
    trace_address: number[];
    type: string;
    address: string | null;
    code: string | null;
    call_type: string | null;
    input: string;
    output: string | null;
    refund_address: string | null;
    block_date: string;
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

        // Split by semicolon and execute each statement separately
        const statements = schema
            .split(';')
            .map(s => {
                // Remove comment lines (lines starting with --)
                const lines = s.split('\n')
                    .filter(line => !line.trim().startsWith('--'));
                return lines.join('\n').trim();
            })
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

    async getLastBlockNumberFromTransactions(): Promise<number> {
        const result = await this.client.query({
            query: 'SELECT max(block_number) as max_block FROM transactions',
            format: 'JSONEachRow',
        });

        const rows = await result.json<{ max_block: number | string | null }>();
        if (rows.length === 0 || rows[0].max_block === null || rows[0].max_block === 0 || rows[0].max_block === '0') {
            return -1;
        }
        return Number(rows[0].max_block);
    }

    async getLastBlockNumberFromTraces(): Promise<number> {
        const result = await this.client.query({
            query: 'SELECT max(block_number) as max_block FROM traces',
            format: 'JSONEachRow',
        });

        const rows = await result.json<{ max_block: number | string | null }>();
        if (rows.length === 0 || rows[0].max_block === null || rows[0].max_block === 0 || rows[0].max_block === '0') {
            return -1;
        }
        return Number(rows[0].max_block);
    }

    async getLastBlockNumber(): Promise<{ min: number; logs: number; blocks: number; transactions: number; traces: number }> {
        const [logsLast, blocksLast, transactionsLast, tracesLast] = await Promise.all([
            this.getLastLogBlockNumber(),
            this.getLastBlockNumberFromBlocks(),
            this.getLastBlockNumberFromTransactions(),
            this.getLastBlockNumberFromTraces(),
        ]);

        return {
            min: Math.min(logsLast, blocksLast, transactionsLast, tracesLast),
            logs: logsLast,
            blocks: blocksLast,
            transactions: transactionsLast,
            traces: tracesLast,
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

    async insertTransactions(transactions: TransactionRow[]): Promise<void> {
        if (transactions.length === 0) return;

        await this.client.insert({
            table: 'transactions',
            values: transactions,
            format: 'JSONEachRow',
        });
    }

    async insertTraces(traces: TraceRow[]): Promise<void> {
        if (traces.length === 0) return;

        await this.client.insert({
            table: 'traces',
            values: traces,
            format: 'JSONEachRow',
        });
    }

    async close(): Promise<void> {
        await this.client.close();
    }
}

