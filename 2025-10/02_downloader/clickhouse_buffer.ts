import { createClient, ClickHouseClient } from '@clickhouse/client';
import type { ArchivedBlock } from './types.ts';

interface LogRow {
    block_time: number;
    block_number: string;
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

interface TraceRow {
    block_time: number;
    block_number: string;
    value: string;
    gas: string;
    gas_used: string;
    block_hash: string;
    success: boolean;
    tx_index: number;
    sub_traces: string;
    error: string;
    tx_success: boolean;
    tx_hash: string;
    trace_from: string;
    trace_to: string;
    trace_address: string[];
    trace_type: string;
    address: string;
    code: string;
    call_type: string;
    input: string;
    output: string;
    refund_address: string;
    block_date: string;
}

export class ClickHouseBuffer {
    private client: ClickHouseClient;
    private logsBuffer: LogRow[] = [];
    private tracesBuffer: TraceRow[] = [];
    private txCount: number = 0;
    private flushInterval: NodeJS.Timeout | null = null;

    constructor(options: {
        url?: string;
        username?: string;
        password?: string;
    } = {}) {
        this.client = createClient({
            url: options.url ?? 'http://localhost:8123',
            username: options.username ?? 'default',
            password: options.password ?? 'nopassword',
        });
    }

    async initialize() {
        await this.createTables();
        this.startFlushInterval();
    }

    private async createTables() {
        await this.client.exec({
            query: `
                CREATE TABLE IF NOT EXISTS logs (
                    block_time DateTime,
                    block_number UInt64,
                    block_hash String,
                    contract_address String,
                    topic0 String,
                    topic1 String,
                    topic2 String,
                    topic3 String,
                    data String,
                    tx_hash String,
                    log_index UInt32,
                    tx_index UInt32,
                    block_date Date,
                    tx_from String,
                    tx_to String
                ) ENGINE = MergeTree()
                PARTITION BY toYYYYMM(block_time)
                ORDER BY (block_number, tx_index, log_index)
            `
        });

        await this.client.exec({
            query: `
                CREATE TABLE IF NOT EXISTS traces (
                    block_time DateTime,
                    block_number UInt64,
                    value String,
                    gas UInt64,
                    gas_used UInt64,
                    block_hash String,
                    success UInt8,
                    tx_index UInt32,
                    sub_traces UInt64,
                    error String,
                    tx_success UInt8,
                    tx_hash String,
                    trace_from String,
                    trace_to String,
                    trace_address Array(UInt64),
                    trace_type String,
                    address String,
                    code String,
                    call_type String,
                    input String,
                    output String,
                    refund_address String,
                    block_date Date
                ) ENGINE = MergeTree()
                PARTITION BY toYYYYMM(block_time)
                ORDER BY (block_number, tx_index, trace_address)
            `
        });

        console.log('ClickHouse tables created');
    }

    addBlock(block: ArchivedBlock) {
        const timestamp = Number(block.block.timestamp);
        const blockNumber = block.block.number!;
        const blockHash = block.block.hash!;
        const blockDate = new Date(timestamp * 1000).toISOString().split('T')[0];

        this.txCount += block.block.transactions.length;

        // Process logs from receipts
        block.receipts.forEach((receipt, txIndex) => {
            receipt.logs.forEach((log, logIndex) => {
                this.logsBuffer.push({
                    block_time: timestamp,
                    block_number: blockNumber.toString(),
                    block_hash: blockHash,
                    contract_address: log.address,
                    topic0: log.topics[0] ?? '',
                    topic1: log.topics[1] ?? '',
                    topic2: log.topics[2] ?? '',
                    topic3: log.topics[3] ?? '',
                    data: log.data,
                    tx_hash: receipt.transactionHash,
                    log_index: logIndex,
                    tx_index: txIndex,
                    block_date: blockDate,
                    tx_from: receipt.from,
                    tx_to: receipt.to ?? '',
                });
            });
        });

        // Process traces
        if (block.traces) {
            block.traces.forEach((traceResult, txIndex) => {
                const receipt = block.receipts[txIndex];
                this.flattenTrace(
                    traceResult.result,
                    [],
                    timestamp,
                    blockNumber,
                    blockHash,
                    blockDate,
                    traceResult.txHash,
                    txIndex,
                    receipt?.status === 'success'
                );
            });
        }
    }

    private flattenTrace(
        trace: any,
        traceAddress: number[],
        blockTime: number,
        blockNumber: bigint,
        blockHash: string,
        blockDate: string,
        txHash: string,
        txIndex: number,
        txSuccess: boolean
    ) {
        if (!trace) return;

        const parseHexOrNumber = (val: any): string => {
            if (!val) return '0';
            if (typeof val === 'string' && val.startsWith('0x')) {
                return BigInt(val).toString();
            }
            return val.toString();
        };

        this.tracesBuffer.push({
            block_time: blockTime,
            block_number: blockNumber.toString(),
            value: parseHexOrNumber(trace.value),
            gas: parseHexOrNumber(trace.gas),
            gas_used: parseHexOrNumber(trace.gasUsed),
            block_hash: blockHash,
            success: trace.error ? false : true,
            tx_index: txIndex,
            sub_traces: (trace.calls?.length ?? 0).toString(),
            error: trace.error ?? '',
            tx_success: txSuccess,
            tx_hash: txHash,
            trace_from: trace.from ?? '',
            trace_to: trace.to ?? '',
            trace_address: traceAddress.map(n => n.toString()),
            trace_type: trace.type ?? '',
            address: trace.address ?? '',
            code: trace.code ?? '',
            call_type: trace.callType ?? '',
            input: trace.input ?? '',
            output: trace.output ?? '',
            refund_address: trace.refundAddress ?? '',
            block_date: blockDate,
        });

        // Recursively process child calls
        if (trace.calls) {
            trace.calls.forEach((childTrace: any, index: number) => {
                this.flattenTrace(
                    childTrace,
                    [...traceAddress, index],
                    blockTime,
                    blockNumber,
                    blockHash,
                    blockDate,
                    txHash,
                    txIndex,
                    txSuccess
                );
            });
        }
    }

    private startFlushInterval() {
        this.flushInterval = setInterval(() => {
            this.flush().catch(error => {
                console.error('Error flushing buffer:', error);
            });
        }, 10000);
    }

    async flush() {
        const logsToFlush = this.logsBuffer;
        const tracesToFlush = this.tracesBuffer;
        const txsToFlush = this.txCount;

        this.logsBuffer = [];
        this.tracesBuffer = [];
        this.txCount = 0;

        if (logsToFlush.length === 0 && tracesToFlush.length === 0) {
            return;
        }

        const start = Date.now();

        if (logsToFlush.length > 0) {
            await this.client.insert({
                table: 'logs',
                values: logsToFlush,
                format: 'JSONEachRow',
            });
        }

        if (tracesToFlush.length > 0) {
            await this.client.insert({
                table: 'traces',
                values: tracesToFlush,
                format: 'JSONEachRow',
            });
        }

        const ms = Date.now() - start;
        const totalRows = logsToFlush.length + tracesToFlush.length;
        const rowsPerSecond = Math.round((totalRows / ms) * 1000);
        const txsPerSecond = Math.round((txsToFlush / ms) * 1000);

        console.log(
            `Flushed ${logsToFlush.length} logs, ${tracesToFlush.length} traces (${txsToFlush} txs) | ` +
            `${ms}ms | ${txsPerSecond} tx/s`
        );
    }

    async close() {
        if (this.flushInterval) {
            clearInterval(this.flushInterval);
        }
        await this.flush();
        await this.client.close();
    }
}

