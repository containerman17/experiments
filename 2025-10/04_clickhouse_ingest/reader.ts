import path from "path";
import { LocalBlockReader } from "./lib/LocalBlockReader.ts";

const dir = path.join(process.cwd(), "data", "2q9e4r6Mu3U68nU1fYjgbR6JvwrRx36CohpAX5UQxse55x1Q5");

const reader = new LocalBlockReader(dir);


let lastTxCount = 0
let totalTx = 0
let batchCount = 0
const start = Date.now();
setInterval(() => {
    const now = Date.now();
    const txsPerSecond = totalTx - lastTxCount;
    lastTxCount = totalTx;
    console.log(`${txsPerSecond} txs/s, avg: ${(totalTx / ((now - start) / 1000) / 1000).toFixed(2)}K txs/s, batches: ${batchCount}, last ingested block: ${lastIngestedBlock}`);
}, 1000);

let lastIngestedBlock = 0;


for await (const { block, isLastInBatch } of reader.blocks()) {
    totalTx += block.block.transactions.length;
    lastIngestedBlock = Number(block.block.number);
    // When we hit the end of a batch, this is a good time to commit to DB
    if (isLastInBatch) {
        batchCount++;
    }
}

