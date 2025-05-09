import { fetchBlockAndReceipts, getCurrentBlockNumber } from "./rpc";
import { saveToDb, loadFromDb } from "./db";
import { lastProcessed } from "./lastProcessed";
import { incrementAddedThisSecond } from "./stats";
const MAX_CONCURRENCY = 100;
let activePromises = 0;

let lastBlockOnChain = await getCurrentBlockNumber();
let lastScannedBlock = 0;
try {
    lastScannedBlock = await loadFromDb<number>('lastScannedBlock');
    console.log(`Last scanned block: ${lastScannedBlock}`);
} catch (e) {
    console.warn('No last scanned block found, starting from 0');
}

lastProcessed.setLastProcessed(lastScannedBlock);


lastProcessed.onIncremented(async (lastProcessed) => {
    lastProcessed % 100 === 0 && console.log(`Last processed block: ${lastProcessed}`);
    await saveToDb('lastScannedBlock', lastProcessed);
});

const tasks = [];
console.log(`lastBlockOnChain=${lastBlockOnChain} lastScannedBlock=${lastScannedBlock}`);
while (lastBlockOnChain > lastScannedBlock) {
    // Wait if we've reached our concurrency limit
    if (activePromises >= MAX_CONCURRENCY) {
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
    }

    const blockNumber = ++lastScannedBlock;
    activePromises++;

    const promise = (async () => {
        try {
            const block = await fetchBlockAndReceipts(blockNumber);
            await saveToDb('block-' + blockNumber.toString(), block);
            incrementAddedThisSecond();
            lastProcessed.reportProcessed(Number(blockNumber));
        } finally {
            activePromises--;
        }
    })();

    tasks.push(promise);
}
await Promise.all(tasks);
