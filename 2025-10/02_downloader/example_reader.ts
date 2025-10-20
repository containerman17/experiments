import path from "path";
import { LocalBlockReader } from "./readWriter.ts";

const dir = path.join(process.cwd(), "data", "2q9e4r6Mu3U68nU1fYjgbR6JvwrRx36CohpAX5UQxse55x1Q5");

const reader = new LocalBlockReader(dir);

let count = 0;
let lastBlock = 0;
let expectedBlock = 1;

console.log('Starting reader...');
let totalTxs = 0;

// Progress tracking
const totalTxsTarget = 760_000_000;

let lastTxCount = 0;
const start = Date.now();

setInterval(() => {
    const percentage = (totalTxs / totalTxsTarget * 100).toFixed(4);
    const elapsedSeconds = (Date.now() - start) / 1000;
    const intervalTxs = totalTxs - lastTxCount;
    const txsPerSecond = intervalTxs;
    const avgTxsPerSecond = (totalTxs / elapsedSeconds).toFixed(2);

    // Calculate time left (based on avg txs/sec)
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
        const blockNum = Number(block.block.number);

        // Validate sequential order
        if (blockNum !== expectedBlock) {
            throw new Error(`Block sequence error: expected ${expectedBlock}, got ${blockNum}`);
        }

        count++;
        expectedBlock++;

        totalTxs += block.block.transactions.length;


        lastBlock = blockNum;
    }

    console.log(`✓ Validation passed: ${count} blocks in perfect sequence from 1 to ${lastBlock}`);
})().catch(console.error);

// Show stats every 5 seconds
setInterval(() => {
    console.log(`[Stats] Total blocks read: ${count}, last block: ${lastBlock}`);
}, 5000);

