import path from "path";
import { LocalBlockReader } from "./readWriter.ts";

const dir = path.join(process.cwd(), "data", "C-Chain");

const reader = new LocalBlockReader(dir);

let count = 0;
let lastBlock = 0;
let expectedBlock = 1;

console.log('Starting reader...');
const start = Date.now();
let totalTxs = 0;
(async () => {
    for await (const block of reader.blocks()) {
        const blockNum = Number(block.block.number);

        // Validate sequential order
        if (blockNum !== expectedBlock) {
            throw new Error(`Block sequence error: expected ${expectedBlock}, got ${blockNum}`);
        }

        count++;
        expectedBlock++;

        // Log every 100 blocks
        if (count % 100 === 0) {
            console.log(`Read ${count} blocks, current: ${blockNum}, txs: ${totalTxs}`);
        }
        totalTxs += block.block.transactions.length;


        lastBlock = blockNum;
    }

    console.log(`✓ Validation passed: ${count} blocks in perfect sequence from 1 to ${lastBlock}`);
})().catch(console.error);

// Show stats every 5 seconds
setInterval(() => {
    console.log(`[Stats] Total blocks read: ${count}, last block: ${lastBlock}`);
}, 5000);

