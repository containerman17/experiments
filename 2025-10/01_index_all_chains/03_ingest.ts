import { createClient as createClickHouseClient } from '@clickhouse/client';
import type { CallTrace, IngestBlockParams, TraceResult } from './types.ts';
import { formatBlockNumber, START_BLOCK } from './const.ts';

const CLICKHOUSE_HOST = 'http://localhost:8123';
const CLICKHOUSE_DATABASE = 'default';
const CLICKHOUSE_PASSWORD = 'nopassword';
const BATCH_SIZE = 10000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS traces (
    tx_hash FixedString(32),
    tx_index UInt16,
    tx_success Bool,
    block_number UInt32,
    block_hash FixedString(32),
    block_time DateTime,
    block_date Date,
    trace_address Array(UInt16),
    type LowCardinality(String),
    call_type LowCardinality(Nullable(String)),
    success Bool,
    error Nullable(String),
    sub_traces UInt16,
    from FixedString(20),
    to Nullable(FixedString(20)),
    address Nullable(FixedString(20)),
    refund_address Nullable(FixedString(20)),
    gas UInt32,
    gas_used UInt32,
    net_gas UInt32,
    value UInt256,
    input String,
    output Nullable(String),
    code Nullable(String)
)
ENGINE = ReplacingMergeTree()
PARTITION BY toYYYYMM(block_date)
ORDER BY (block_number, tx_index, trace_address)
SETTINGS index_granularity = 8192;
`;

const clickhouse = createClickHouseClient({
    host: CLICKHOUSE_HOST,
    database: CLICKHOUSE_DATABASE,
    password: CLICKHOUSE_PASSWORD,
});

// Create traces table
// await clickhouse.command({ query: 'DROP TABLE IF EXISTS traces' });
await clickhouse.command({ query: SCHEMA });
console.log('Traces table created/verified');

// Find last processed block
const lastBlockResult = await clickhouse.query({
    query: 'SELECT MAX(block_number) as max_block FROM traces',
});
const lastBlockData = await lastBlockResult.json<{ max_block: number }>();
const lastProcessedBlock = lastBlockData.data[0]?.max_block || 0;
const startFrom = lastProcessedBlock > 0 ? lastProcessedBlock + 1 : START_BLOCK;

console.log(`Resuming from block ${startFrom} (last processed: ${lastProcessedBlock || 'none'})`);

let processed = 0;
let totalTxs = 0;
let buffer: FlatTrace[] = [];
let currentBlock = startFrom;
const startTime = Date.now();
const BLOCK_FETCH_BATCH = 20;

try {
    while (true) {
        // Generate batch of block numbers
        const blockBatch = Array.from({ length: BLOCK_FETCH_BATCH }, (_, i) => currentBlock + i);
        const formattedBlocks = blockBatch.map(formatBlockNumber);

        const result = await clickhouse.query({
            query: `SELECT block_number, data FROM blocks_data WHERE block_number IN (${formattedBlocks.map(b => `'${b}'`).join(',')}) ORDER BY block_number`,
        });

        const rows = await result.json<{ block_number: string; data: string }>();

        if (rows.data.length === 0) {
            console.log(`No blocks found starting at ${currentBlock}, stopping`);
            break;
        }

        for (const row of rows.data) {
            const blockData: IngestBlockParams = JSON.parse(row.data);
            const traces = processBlock(blockData);
            buffer.push(...traces);

            totalTxs += blockData.traces.length;
            processed++;
            if (processed % 100 === 0) {
                console.log(`Processed ${processed} blocks (current: ${currentBlock + rows.data.indexOf(row)}) at ${Math.round(totalTxs / ((Date.now() - startTime) / 1000))} txs per second`);
            }

            if (buffer.length >= BATCH_SIZE) {
                await insertTraces(buffer);
                buffer = [];
            }
        }

        // If we got fewer blocks than requested, we're at the end
        if (rows.data.length < BLOCK_FETCH_BATCH) {
            console.log(`Reached end of available blocks`);
            break;
        }

        currentBlock += BLOCK_FETCH_BATCH;
    }

    if (buffer.length > 0) {
        await insertTraces(buffer);
    }

    console.log(`✓ Completed: ${processed} blocks, ${totalTxs} txs processed at ${Math.round(totalTxs / ((Date.now() - startTime) / 1000))} txs per second`);
} catch (error) {
    console.error('Error during ingestion:', error);
} finally {
    await clickhouse.close();
}

interface FlatTrace {
    tx_hash: string;
    tx_index: number;
    tx_success: boolean;
    block_number: number;
    block_hash: string;
    block_time: number;
    block_date: string;
    trace_address: number[];
    type: string;
    call_type: string | null;
    success: boolean;
    error: string | null;
    sub_traces: number;
    from: string;
    to: string | null;
    address: string | null;
    refund_address: string | null;
    gas: number;
    gas_used: number;
    net_gas: number;
    value: string;
    input: string;
    output: string | null;
    code: string | null;
}

function processBlock(blockData: IngestBlockParams): FlatTrace[] {
    const allTraces: FlatTrace[] = [];

    for (let txIndex = 0; txIndex < blockData.traces.length; txIndex++) {
        const traceResult = blockData.traces[txIndex];
        const tx = blockData.transactions[txIndex];
        const receipt = blockData.receipts[txIndex];

        if (!traceResult?.result) continue;

        const blockTime = Number(tx.blockNumber);
        const flatTraces = flattenTrace(
            traceResult.result,
            [],
            {
                tx_hash: hexToRaw(traceResult.txHash),
                tx_index: txIndex,
                tx_success: receipt.status === 'success',
                block_number: blockTime,
                block_hash: hexToRaw(tx.blockHash!),
                block_time: blockTime,
                block_date: new Date(blockTime * 1000).toISOString().split('T')[0],
            }
        );

        allTraces.push(...flatTraces);
    }

    return allTraces;
}

function flattenTrace(
    trace: CallTrace,
    traceAddress: number[],
    context: {
        tx_hash: string;
        tx_index: number;
        tx_success: boolean;
        block_number: number;
        block_hash: string;
        block_time: number;
        block_date: string;
    }
): FlatTrace[] {
    const children = trace.calls || [];
    const childGasUsed = children.reduce((sum, child) => sum + hexToNumber(child.gasUsed), 0);
    const gasUsed = hexToNumber(trace.gasUsed);
    const netGas = gasUsed - childGasUsed;

    //FIXME: 
    if (!!(trace as any).txHash && (trace as any).result) {
        trace = (trace as any).result as CallTrace;
    }

    if (!trace.type) {
        console.log(trace);
        throw new Error('Trace type is undefined');
    }

    const flatTrace: FlatTrace = {
        ...context,
        trace_address: traceAddress,
        type: trace.type.toUpperCase(),
        call_type: extractCallType(trace.type),
        success: true,
        error: null,
        sub_traces: children.length,
        from: hexToRaw(trace.from),
        to: trace.to ? hexToRaw(trace.to) : null,
        address: null,
        refund_address: null,
        gas: hexToNumber(trace.gas),
        gas_used: gasUsed,
        net_gas: netGas,
        value: hexToBigInt(trace.value).toString(),
        input: hexToRaw(trace.input),
        output: null,
        code: null,
    };

    const childTraces = children.flatMap((child, idx) =>
        flattenTrace(child, [...traceAddress, idx], context)
    );

    return [flatTrace, ...childTraces];
}

async function insertTraces(traces: FlatTrace[]): Promise<void> {
    if (traces.length === 0) return;

    const values = traces.map(t =>
        `(unhex('${t.tx_hash}'),${t.tx_index},${t.tx_success},${t.block_number},unhex('${t.block_hash}'),${t.block_time},'${t.block_date}',[${t.trace_address.join(',')}],'${t.type}',${t.call_type ? `'${t.call_type}'` : 'NULL'},${t.success},${t.error ? `'${t.error}'` : 'NULL'},${t.sub_traces},unhex('${t.from}'),${t.to ? `unhex('${t.to}')` : 'NULL'},${t.address ? `unhex('${t.address}')` : 'NULL'},${t.refund_address ? `unhex('${t.refund_address}')` : 'NULL'},${t.gas},${t.gas_used},${t.net_gas},${t.value},unhex('${t.input}'),${t.output ? `unhex('${t.output}')` : 'NULL'},${t.code ? `unhex('${t.code}')` : 'NULL'})`
    ).join(',');

    await clickhouse.command({
        query: `INSERT INTO traces VALUES ${values}`,
    });
}

function hexToRaw(hex: string): string {
    return hex.startsWith('0x') ? hex.slice(2) : hex;
}

function hexToNumber(hex: string | undefined): number {
    if (!hex) return 0;
    return parseInt(hex, 16);
}

function hexToBigInt(hex: string | undefined): bigint {
    if (!hex || hex === '0x' || hex === '0x0') return 0n;
    return BigInt(hex);
}

function extractCallType(type: string): string | null {
    const upper = type.toUpperCase();
    if (upper.includes('CALL')) return upper;
    return null;
}
