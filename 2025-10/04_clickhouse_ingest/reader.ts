import path from "path";
import { LocalBlockReader } from "./lib/LocalBlockReader.ts";
import { ClickHouseWriter } from "./clickhouse/client.ts";
import { transformBlockToLogs } from "./clickhouse/transformations.ts";
import type { LogRow } from "./clickhouse/client.ts";

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

// Get the last ingested block from the database
const lastDbBlock = await clickhouse.getLastLogBlockNumber();
console.log(`Last block in database: ${lastDbBlock}`);

// Start from the block after the last one in the database
const startFromBlock = lastDbBlock;

const reader = new LocalBlockReader(dir, startFromBlock); // true = fast mode, skip sorting & validation

// Buffering and backpressure configuration
const HIGH_WATERMARK = 1000000;  // Pause reading when buffer reaches this
const LOW_WATERMARK = 200_000;    // Resume reading when buffer drops to this

let buffer: LogRow[] = [];
let totalLogs = 0;
let lastLogCount = 0;
let totalTxs = 0;
let lastTxCount = 0;
let lastIngestedBlock = lastDbBlock;
let shouldStop = false;
let isPaused = false;

const start = Date.now();

// Separate commit loop (runs independently)
async function commitLoop() {
    while (!shouldStop) {
        while (buffer.length < LOW_WATERMARK && !shouldStop) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }

        const batch = buffer.splice(0);

        const start = Date.now();
        await clickhouse.insertLogs(batch);
        const linesPerSecond = batch.length / ((Date.now() - start) / 1000);
        console.log(`inserted ${batch.length} logs in ${Date.now() - start}ms (${(linesPerSecond / 1000).toFixed(0)}K lines/sec)`);
    }

    // Final flush when stopping
    if (buffer.length > 0) {
        await clickhouse.insertLogs(buffer);
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
    lastLogCount = totalLogs;
    lastTxCount = totalTxs;
    console.log(`${txsPerSecond} txs/s, ${logsPerSecond} logs/s, avg: ${(totalTxs / ((now - start) / 1000)).toFixed(0)} txs/s, buffer: ${buffer.length}, last block: ${lastIngestedBlock}, paused: ${isPaused}`);
}, 1000);

// Main processing loop
for await (const { block, isLastInBatch } of reader.blocks()) {
    const logs = transformBlockToLogs(block);
    buffer.push(...logs);
    totalLogs += logs.length;
    totalTxs += block.block.transactions.length;
    lastIngestedBlock = Number(block.block.number);

    // Backpressure with hysteresis
    if (!isPaused && buffer.length >= HIGH_WATERMARK) {
        isPaused = true;
        console.log(`Buffer reached ${HIGH_WATERMARK.toLocaleString()} (high watermark), pausing reads...`);
    }

    while (isPaused) {
        if (buffer.length <= LOW_WATERMARK) {
            isPaused = false;
            console.log(`Buffer drained to ${buffer.length.toLocaleString()} (≤${LOW_WATERMARK.toLocaleString()} low watermark), resuming reads...`);
            break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

// Final cleanup
shouldStop = true;
await commitLoopPromise;
await clickhouse.close();
console.log(`Finished. Total logs processed: ${totalLogs}`);
