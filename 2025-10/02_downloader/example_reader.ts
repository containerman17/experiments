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
            console.log(`Read ${count} blocks, current: ${blockNum}, txs: ${block.receipts.length}`);
        }
        totalTxs += block.block.transactions.length;

        if (block.block.transactions.length > 1) {
            console.log(`Block ${blockNum} has ${block.block.transactions.length} transactions`);
            console.log(block)
            process.exit(0);
        }


        lastBlock = blockNum;

        if (blockNum === 30000) {
            const end = Date.now();
            const duration = end - start;
            console.log(`Time taken: ${duration}ms`);
            console.log(`Total txs: ${totalTxs}`);
            process.exit(0);
        }
    }

    console.log(`✓ Validation passed: ${count} blocks in perfect sequence from 1 to ${lastBlock}`);
})().catch(console.error);

// Show stats every 5 seconds
setInterval(() => {
    console.log(`[Stats] Total blocks read: ${count}, last block: ${lastBlock}`);
}, 5000);

