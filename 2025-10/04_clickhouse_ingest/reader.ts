import path from "path";
import { LocalBlockReader } from "./lib/LocalBlockReader.ts";
import { ClickHouseWriter } from "./clickhouse/client.ts";
import { transformBlockToLogs, transformBlockToBlockRow, transformBlockToTransactions, transformBlockToTraces } from "./clickhouse/transformations.ts";
import type { LogRow, BlockRow, TransactionRow, TraceRow } from "./clickhouse/client.ts";

const dir = path.join("/data", "2q9e4r6Mu3U68nU1fYjgbR6JvwrRx36CohpAX5UQxse55x1Q5");

// ClickHouse configuration
const clickhouse = new ClickHouseWriter({
    host: process.env.CLICKHOUSE_HOST || 'http://localhost:8123',
    database: process.env.CLICKHOUSE_DATABASE || 'default',
    username: process.env.CLICKHOUSE_USER,
    password: process.env.CLICKHOUSE_PASSWORD || "nopassword",
});

// Initialize schema
await clickhouse.initialize();
console.log('ClickHouse schema initialized');

// Get the last ingested block from each table
const lastBlocks = await clickhouse.getLastBlockNumber();
console.log(`Last blocks - logs: ${lastBlocks.logs}, blocks: ${lastBlocks.blocks}, transactions: ${lastBlocks.transactions}, traces: ${lastBlocks.traces}, starting from: ${lastBlocks.min}`);

// Start from the minimum to ensure no gaps
const startFromBlock = lastBlocks.min;
let lastLogsBlock = lastBlocks.logs;
let lastBlocksBlock = lastBlocks.blocks;
let lastTransactionsBlock = lastBlocks.transactions;
let lastTracesBlock = lastBlocks.traces;

const reader = new LocalBlockReader(dir, startFromBlock);

// Buffering and backpressure configuration
const HIGH_WATERMARK = 500_000;  // Pause reading when buffer reaches this
const LOW_WATERMARK = HIGH_WATERMARK * 0.25;    // Resume reading when buffer drops to this

let logsBuffer: LogRow[] = [];
let blocksBuffer: BlockRow[] = [];
let transactionsBuffer: TransactionRow[] = [];
let tracesBuffer: TraceRow[] = [];
let totalLogs = 0;
let lastLogCount = 0;
let totalTxs = 0;
let lastTxCount = 0;
let totalBlocks = 0;
let lastBlockCount = 0;
let totalTraces = 0;
let lastTraceCount = 0;
let lastIngestedBlock = startFromBlock;
let shouldStop = false;
let isPaused = false;

const start = Date.now();

// Separate commit loop (runs independently)
async function commitLoop() {
    while (!shouldStop) {
        while (logsBuffer.length < LOW_WATERMARK && blocksBuffer.length < LOW_WATERMARK && transactionsBuffer.length < LOW_WATERMARK && tracesBuffer.length < LOW_WATERMARK && !shouldStop) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }

        const logsBatch = logsBuffer.splice(0);
        const blocksBatch = blocksBuffer.splice(0);
        const transactionsBatch = transactionsBuffer.splice(0);
        const tracesBatch = tracesBuffer.splice(0);

        const start = Date.now();

        // Insert to all four tables in parallel
        await Promise.all([
            logsBatch.length > 0 ? clickhouse.insertLogs(logsBatch) : Promise.resolve(),
            blocksBatch.length > 0 ? clickhouse.insertBlocks(blocksBatch) : Promise.resolve(),
            transactionsBatch.length > 0 ? clickhouse.insertTransactions(transactionsBatch) : Promise.resolve(),
            tracesBatch.length > 0 ? clickhouse.insertTraces(tracesBatch) : Promise.resolve(),
        ]);

        // Update the last successfully inserted block for each table
        if (logsBatch.length > 0) {
            lastLogsBlock = logsBatch[logsBatch.length - 1].block_number;
        }
        if (blocksBatch.length > 0) {
            lastBlocksBlock = blocksBatch[blocksBatch.length - 1].number;
        }
        if (transactionsBatch.length > 0) {
            lastTransactionsBlock = transactionsBatch[transactionsBatch.length - 1].block_number;
        }
        if (tracesBatch.length > 0) {
            lastTracesBlock = tracesBatch[tracesBatch.length - 1].block_number;
        }

        const linesPerSecond = (logsBatch.length + blocksBatch.length + transactionsBatch.length + tracesBatch.length) / ((Date.now() - start) / 1000);
        console.log(`inserted ${logsBatch.length} logs, ${blocksBatch.length} blocks, ${transactionsBatch.length} txs, ${tracesBatch.length} traces in ${Date.now() - start}ms (${(linesPerSecond / 1000).toFixed(0)}K lines/sec)`);
    }

    // Final flush when stopping
    if (logsBuffer.length > 0 || blocksBuffer.length > 0 || transactionsBuffer.length > 0 || tracesBuffer.length > 0) {
        await Promise.all([
            logsBuffer.length > 0 ? clickhouse.insertLogs(logsBuffer) : Promise.resolve(),
            blocksBuffer.length > 0 ? clickhouse.insertBlocks(blocksBuffer) : Promise.resolve(),
            transactionsBuffer.length > 0 ? clickhouse.insertTransactions(transactionsBuffer) : Promise.resolve(),
            tracesBuffer.length > 0 ? clickhouse.insertTraces(tracesBuffer) : Promise.resolve(),
        ]);
    }
}

// Start the commit loop
const commitLoopPromise = commitLoop();

// Stats interval
setInterval(() => {
    if (shouldStop) return;
    const now = Date.now();
    const logsPerSecond = totalLogs - lastLogCount;
    const txsPerSecond = totalTxs - lastTxCount;
    const blocksPerSecond = totalBlocks - lastBlockCount;
    const tracesPerSecond = totalTraces - lastTraceCount;
    lastLogCount = totalLogs;
    lastTxCount = totalTxs;
    lastBlockCount = totalBlocks;
    lastTraceCount = totalTraces;
    console.log(`${txsPerSecond} txs/s, ${logsPerSecond} logs/s, ${blocksPerSecond} blocks/s, ${tracesPerSecond} traces/s, buffers: ${logsBuffer.length}/${blocksBuffer.length}/${transactionsBuffer.length}/${tracesBuffer.length}, last block: ${lastIngestedBlock.toLocaleString()}, logs@${lastLogsBlock.toLocaleString()}, blocks@${lastBlocksBlock.toLocaleString()}, txs@${lastTransactionsBlock.toLocaleString()}, traces@${lastTracesBlock.toLocaleString()}, paused: ${isPaused}`);
}, 1000);

// Main processing loop
for await (const { block, isLastInBatch } of reader.blocks()) {
    const blockNumber = Number(block.block.number);

    // Only insert logs if this block is newer than what's in the logs table
    if (blockNumber > lastLogsBlock) {
        const logs = transformBlockToLogs(block);
        logsBuffer.push(...logs);
        totalLogs += logs.length;
    }

    // Only insert block if this block is newer than what's in the blocks table
    if (blockNumber > lastBlocksBlock) {
        const blockRow = transformBlockToBlockRow(block);
        blocksBuffer.push(blockRow);
        totalBlocks++;
    }

    // Only insert transactions if this block is newer than what's in the transactions table
    if (blockNumber > lastTransactionsBlock) {
        const transactions = transformBlockToTransactions(block);
        transactionsBuffer.push(...transactions);
    }

    // Only insert traces if this block is newer than what's in the traces table
    if (blockNumber > lastTracesBlock) {
        const traces = transformBlockToTraces(block);
        tracesBuffer.push(...traces);
        totalTraces += traces.length;
    }

    totalTxs += block.block.transactions.length;
    lastIngestedBlock = blockNumber;

    // Backpressure with hysteresis based on total buffer size
    const totalBufferSize = logsBuffer.length + blocksBuffer.length + transactionsBuffer.length + tracesBuffer.length;
    if (!isPaused && totalBufferSize >= HIGH_WATERMARK) {
        isPaused = true;
        console.log(`Buffer reached ${totalBufferSize.toLocaleString()} (high watermark), pausing reads...`);
    }

    while (isPaused) {
        const currentBufferSize = logsBuffer.length + blocksBuffer.length + transactionsBuffer.length + tracesBuffer.length;
        if (currentBufferSize <= LOW_WATERMARK) {
            isPaused = false;
            console.log(`Buffer drained to ${currentBufferSize.toLocaleString()} (≤${LOW_WATERMARK.toLocaleString()} low watermark), resuming reads...`);
            break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

// Final cleanup
shouldStop = true;
await commitLoopPromise;
await clickhouse.close();
console.log(`Finished. Total: ${totalBlocks} blocks, ${totalLogs} logs, ${totalTxs} transactions, ${totalTraces} traces`);
