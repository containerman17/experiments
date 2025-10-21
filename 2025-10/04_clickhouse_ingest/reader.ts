import path from "path";
import { LocalBlockReader } from "./lib/LocalBlockReader.ts";
import { ClickHouseWriter } from "./clickhouse/client.ts";
import { transformBlockToLogs } from "./clickhouse/transformations.ts";
import type { LogRow } from "./clickhouse/client.ts";

const dir = path.join(process.cwd(), "data", "2q9e4r6Mu3U68nU1fYjgbR6JvwrRx36CohpAX5UQxse55x1Q5");

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

const reader = new LocalBlockReader(dir, startFromBlock);

// Buffering and backpressure configuration
const BUFFER_LIMIT = 500000;
const COMMIT_INTERVAL_MS = 1000;

let buffer: LogRow[] = [];
let isPaused = false;
let totalLogs = 0;
let lastLogCount = 0;
let lastIngestedBlock = lastDbBlock;

const start = Date.now();

// Commit buffer to database
async function commitBuffer() {
    if (buffer.length === 0) return;

    const logsToInsert = buffer.splice(0);
    await clickhouse.insertLogs(logsToInsert);
}

// Stats interval
setInterval(() => {
    const now = Date.now();
    const logsPerSecond = totalLogs - lastLogCount;
    lastLogCount = totalLogs;
    console.log(`${logsPerSecond} logs/s, avg: ${(totalLogs / ((now - start) / 1000) / 1000).toFixed(2)}K logs/s, buffer: ${buffer.length}, last block: ${lastIngestedBlock}, paused: ${isPaused}`);
}, 1000);

// Commit interval
const commitTimer = setInterval(async () => {
    await commitBuffer();
}, COMMIT_INTERVAL_MS);

// Main processing loop
for await (const { block, isLastInBatch } of reader.blocks()) {
    const logs = transformBlockToLogs(block);
    buffer.push(...logs);
    totalLogs += logs.length;
    lastIngestedBlock = Number(block.block.number);

    // Backpressure: pause if buffer is too large
    if (buffer.length >= BUFFER_LIMIT && !isPaused) {
        isPaused = true;
        console.log(`Buffer full (${buffer.length}), pausing reads and flushing...`);
        await commitBuffer();
        isPaused = false;
    }
}

// Final cleanup
clearInterval(commitTimer);
await commitBuffer();
await clickhouse.close();
console.log(`Finished. Total logs processed: ${totalLogs}`);
