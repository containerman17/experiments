import type { IDB, StoredRawBlock, StoredRawTransaction, StoredEvent, StoredFunctionCall } from "../types.ts";
import { createClient, ClickHouseClient } from '@clickhouse/client';

export class ClickHouseDB implements IDB {
    private client: ClickHouseClient;
    private inTransaction: boolean = false;
    private batchBlocks: StoredRawBlock[] = [];
    private batchTransactions: StoredRawTransaction[] = [];
    private batchEvents: StoredEvent[] = [];
    private batchFunctionCalls: StoredFunctionCall[] = [];

    constructor(client: ClickHouseClient) {
        this.client = client;
    }

    static async create(host: string = 'http://localhost:8123', database: string = 'default'): Promise<ClickHouseDB> {
        const client = createClient({
            host,
            database,
        });
        return new ClickHouseDB(client);
    }

    beginTransaction(): void {
        // ClickHouse doesn't have traditional transactions, we'll use batching
        this.inTransaction = true;
        this.batchBlocks = [];
        this.batchTransactions = [];
        this.batchEvents = [];
        this.batchFunctionCalls = [];
    }

    async commit(): Promise<void> {
        if (!this.inTransaction) return;

        // Insert all batched data
        if (this.batchBlocks.length > 0) {
            await this.client.insert({
                table: 'raw_blocks',
                values: this.batchBlocks,
                format: 'JSONEachRow',
            });
        }

        if (this.batchTransactions.length > 0) {
            await this.client.insert({
                table: 'raw_transactions',
                values: this.batchTransactions,
                format: 'JSONEachRow',
            });
        }

        if (this.batchEvents.length > 0) {
            await this.client.insert({
                table: 'events',
                values: this.batchEvents,
                format: 'JSONEachRow',
            });
        }

        if (this.batchFunctionCalls.length > 0) {
            await this.client.insert({
                table: 'function_calls',
                values: this.batchFunctionCalls,
                format: 'JSONEachRow',
            });
        }

        this.inTransaction = false;
        this.batchBlocks = [];
        this.batchTransactions = [];
        this.batchEvents = [];
        this.batchFunctionCalls = [];
    }

    rollback(): void {
        // Clear batches
        this.inTransaction = false;
        this.batchBlocks = [];
        this.batchTransactions = [];
        this.batchEvents = [];
        this.batchFunctionCalls = [];
    }

    vacuum(): void {
        // ClickHouse handles optimization differently
        // OPTIMIZE TABLE can be called but it's usually not necessary
    }

    async close(): Promise<void> {
        await this.client.close();
    }

    async getTableCounts(): Promise<{ blocks: number, transactions: number, events: number, functionCalls: number }> {
        const blocksResult = await this.client.query({ query: 'SELECT COUNT(*) as count FROM raw_blocks' });
        const blocksData = await blocksResult.json();
        const blocksCount = (blocksData.data[0] as any).count;

        const txResult = await this.client.query({ query: 'SELECT COUNT(*) as count FROM raw_transactions' });
        const txData = await txResult.json();
        const txCount = (txData.data[0] as any).count;

        const eventsResult = await this.client.query({ query: 'SELECT COUNT(*) as count FROM events' });
        const eventsData = await eventsResult.json();
        const eventsCount = (eventsData.data[0] as any).count;

        const callsResult = await this.client.query({ query: 'SELECT COUNT(*) as count FROM function_calls' });
        const callsData = await callsResult.json();
        const callsCount = (callsData.data[0] as any).count;

        return {
            blocks: Number(blocksCount),
            transactions: Number(txCount),
            events: Number(eventsCount),
            functionCalls: Number(callsCount)
        };
    }

    async initialize(): Promise<void> {
        // Create tables with appropriate ClickHouse engines and types
        await this.client.exec({
            query: `
                CREATE TABLE IF NOT EXISTS raw_blocks (
                    number UInt64,
                    hash String,
                    parent_hash String,
                    time UInt64,
                    miner String,
                    difficulty String,
                    total_difficulty String,
                    size UInt64,
                    gas_limit String,
                    gas_used String,
                    base_fee_per_gas Nullable(String),
                    transactions_count UInt32,
                    state_root String,
                    transactions_root String,
                    receipts_root String,
                    extra_data String,
                    logs_bloom String,
                    mix_hash String,
                    nonce String,
                    uncles_hash String,
                    blob_gas_used Nullable(String),
                    excess_blob_gas Nullable(String)
                ) ENGINE = ReplacingMergeTree()
                ORDER BY number;
            `
        });

        await this.client.exec({
            query: `
                CREATE TABLE IF NOT EXISTS raw_transactions (
                    block_number UInt64,
                    block_time UInt64,
                    block_hash String,
                    transaction_index UInt32,
                    hash String,
                    from_address String,
                    to_address Nullable(String),
                    value String,
                    gas String,
                    gas_price Nullable(String),
                    max_fee_per_gas Nullable(String),
                    max_priority_fee_per_gas Nullable(String),
                    priority_fee_per_gas Nullable(String),
                    nonce UInt64,
                    input String,
                    tx_type UInt8,
                    chain_id UInt32,
                    signature_v String,
                    signature_r String,
                    signature_s String,
                    access_list Nullable(String),
                    max_fee_per_blob_gas Nullable(String)
                ) ENGINE = ReplacingMergeTree()
                ORDER BY (block_number, transaction_index);
            `
        });

        // Create indexes for raw_transactions
        await this.client.exec({
            query: `
                CREATE TABLE IF NOT EXISTS events (
                    block_number UInt64,
                    transaction_index UInt32,
                    hash String,
                    topic0 String,
                    topic1 String,
                    topic2 String,
                    topic3 String,
                    data String
                ) ENGINE = MergeTree()
                ORDER BY (block_number, transaction_index);
            `
        });

        await this.client.exec({
            query: `
                CREATE TABLE IF NOT EXISTS function_calls (
                    block_number UInt64,
                    transaction_index UInt32,
                    from_address String,
                    gas String,
                    gas_used String,
                    to_address String,
                    input String,
                    value String,
                    type String
                ) ENGINE = MergeTree()
                ORDER BY (block_number, transaction_index);
            `
        });

        // Create skip indexes for better query performance
        // Hash indexes
        await this.client.exec({
            query: `
                ALTER TABLE raw_blocks ADD INDEX IF NOT EXISTS idx_hash hash TYPE bloom_filter GRANULARITY 1;
            `
        }).catch(() => { }); // Ignore if already exists

        await this.client.exec({
            query: `
                ALTER TABLE raw_blocks ADD INDEX IF NOT EXISTS idx_miner miner TYPE bloom_filter GRANULARITY 1;
            `
        }).catch(() => { });

        await this.client.exec({
            query: `
                ALTER TABLE raw_transactions ADD INDEX IF NOT EXISTS idx_hash hash TYPE bloom_filter GRANULARITY 1;
            `
        }).catch(() => { });

        await this.client.exec({
            query: `
                ALTER TABLE raw_transactions ADD INDEX IF NOT EXISTS idx_from from_address TYPE bloom_filter GRANULARITY 1;
            `
        }).catch(() => { });

        await this.client.exec({
            query: `
                ALTER TABLE raw_transactions ADD INDEX IF NOT EXISTS idx_to to_address TYPE bloom_filter GRANULARITY 1;
            `
        }).catch(() => { });

        await this.client.exec({
            query: `
                ALTER TABLE events ADD INDEX IF NOT EXISTS idx_hash hash TYPE bloom_filter GRANULARITY 1;
            `
        }).catch(() => { });

        await this.client.exec({
            query: `
                ALTER TABLE events ADD INDEX IF NOT EXISTS idx_topic0 topic0 TYPE bloom_filter GRANULARITY 1;
            `
        }).catch(() => { });

        await this.client.exec({
            query: `
                ALTER TABLE function_calls ADD INDEX IF NOT EXISTS idx_from from_address TYPE bloom_filter GRANULARITY 1;
            `
        }).catch(() => { });

        await this.client.exec({
            query: `
                ALTER TABLE function_calls ADD INDEX IF NOT EXISTS idx_to to_address TYPE bloom_filter GRANULARITY 1;
            `
        }).catch(() => { });
    }

    async storeRawBlock(block: StoredRawBlock): Promise<void> {
        if (this.inTransaction) {
            this.batchBlocks.push(block);
        } else {
            await this.client.insert({
                table: 'raw_blocks',
                values: [block],
                format: 'JSONEachRow',
            });
        }
    }

    async storeRawTransaction(transaction: StoredRawTransaction): Promise<number> {
        if (this.inTransaction) {
            this.batchTransactions.push(transaction);
        } else {
            await this.client.insert({
                table: 'raw_transactions',
                values: [transaction],
                format: 'JSONEachRow',
            });
        }
        return transaction.transaction_index;
    }

    async storeEvent(event: StoredEvent): Promise<void> {
        if (this.inTransaction) {
            this.batchEvents.push(event);
        } else {
            await this.client.insert({
                table: 'events',
                values: [event],
                format: 'JSONEachRow',
            });
        }
    }

    async storeFunctionCall(functionCall: StoredFunctionCall): Promise<void> {
        if (this.inTransaction) {
            this.batchFunctionCalls.push(functionCall);
        } else {
            await this.client.insert({
                table: 'function_calls',
                values: [functionCall],
                format: 'JSONEachRow',
            });
        }
    }
}

