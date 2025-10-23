import path from "path";
import { LocalBlockReader } from "./readWriter.ts";
import { ClickHouseBuffer } from "./clickhouse_buffer.ts";

const dir = path.join("/data", "2q9e4r6Mu3U68nU1fYjgbR6JvwrRx36CohpAX5UQxse55x1Q5");

const reader = new LocalBlockReader(dir);
const buffer = new ClickHouseBuffer({
    url: 'http://localhost:8123',
    username: 'default',
    password: 'nopassword',
});

await buffer.initialize();

let count = 0;
let totalTxs = 0;
let totalLogs = 0;
let totalTraces = 0;

const totalTxsTarget = 760_000_000;
let lastTxCount = 0;
const start = Date.now();

setInterval(() => {
    const percentage = (totalTxs / totalTxsTarget * 100).toFixed(4);
    const elapsedSeconds = (Date.now() - start) / 1000;
    const intervalTxs = totalTxs - lastTxCount;
    const txsPerSecond = intervalTxs;
    const avgTxsPerSecond = (totalTxs / elapsedSeconds).toFixed(2);

    let timeLeft = "N/A";
    if (Number(avgTxsPerSecond) > 0) {
        const remainingTxs = totalTxsTarget - totalTxs;
        const secondsLeft = remainingTxs / Number(avgTxsPerSecond);
        const hours = Math.floor(secondsLeft / 3600);
        const minutes = Math.floor((secondsLeft % 3600) / 60);
        const seconds = Math.floor(secondsLeft % 60);
        timeLeft = `${hours}h ${minutes}m ${seconds}s`;
    }

    console.log(
        `Progress: ${percentage}% (${totalTxs}/${totalTxsTarget}). ` +
        `${txsPerSecond} txs/s, avg: ${avgTxsPerSecond} txs/s, time left: ${timeLeft}`
    );
    lastTxCount = totalTxs;
}, 1000);

(async () => {
    for await (const block of reader.blocks()) {
        buffer.addBlock(block);

        count++;
        totalTxs += block.block.transactions.length;
        totalLogs += block.receipts.reduce((sum, r) => sum + r.logs.length, 0);
        if (block.traces) {
            totalTraces += block.traces.length;
        }
    }

    await buffer.close();
    console.log(`✓ Done: ${count} blocks, ${totalTxs} txs, ${totalLogs} logs, ${totalTraces} traces`);
})().catch(async (error) => {
    console.error(error);
    await buffer.close();
    process.exit(1);
});
