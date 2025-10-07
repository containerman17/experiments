import { createPublicClient, http } from 'viem';
import pLimit from 'p-limit';
import fs from 'fs/promises';
import path from 'path';
import * as zstd from 'zstd-napi';

const RPC_URL = 'http://localhost:9650/ext/bc/C/rpc';
const CONCURRENCY = 40; // Lower concurrency since we're fetching more data per block
const BLOCKS_PER_FILE = 1000;
const DATA_DIR = './data';
const START_BLOCK = 68000000;

const client = createPublicClient({
    transport: http(RPC_URL, {
        timeout: 300_000, // 5 minutes
    }),
});

const limit = pLimit(CONCURRENCY);

// Ensure data directory exists
async function ensureDataDir() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
    } catch (error) {
        console.error('Error creating data directory:', error);
        process.exit(1);
    }
}

// Fetch complete block data including transactions and receipts
async function fetchBlockData(blockNumber) {
    const blockNumberHex = '0x' + blockNumber.toString(16);

    // Fetch block with full transactions
    const block = await client.request({
        method: 'eth_getBlockByNumber',
        params: [blockNumberHex, true], // true = include full transaction objects
    });

    // Fetch transaction receipts for all transactions in the block
    const txReceipts = {};
    if (block.transactions && block.transactions.length > 0) {
        const receiptPromises = block.transactions.map(tx =>
            client.request({
                method: 'eth_getTransactionReceipt',
                params: [tx.hash],
            })
        );

        const receipts = await Promise.all(receiptPromises);
        receipts.forEach((receipt, index) => {
            if (receipt) {
                txReceipts[block.transactions[index].hash] = receipt;
            }
        });
    }

    // Fetch traces for the block
    const traces = await client.request({
        method: 'debug_traceBlockByNumber',
        params: [blockNumberHex, { tracer: 'callTracer' }],
    });

    return {
        block,
        txReceipts,
        traces
    };
}

// Process a batch of blocks
async function processBatch(startBlock) {
    // Check if file already exists
    const fileName = `${Math.floor(startBlock / 1000).toString().padStart(7, '0')}xxx.json.zstd`;
    const filePath = path.join(DATA_DIR, fileName);

    try {
        await fs.access(filePath);
        console.log(`⊘ Skipping batch ${startBlock}-${startBlock + BLOCKS_PER_FILE - 1}: ${fileName} already exists`);
        return 0; // Return 0 since we didn't actually process these blocks
    } catch (error) {
        // File doesn't exist, proceed with processing
    }

    const batchData = {};
    const promises = [];

    console.log(`Processing batch: blocks ${startBlock} to ${startBlock + BLOCKS_PER_FILE - 1}`);

    for (let i = 0; i < BLOCKS_PER_FILE; i++) {
        const blockNumber = startBlock + i;
        promises.push(
            limit(async () => {
                const data = await fetchBlockData(blockNumber);
                if (data) {
                    batchData[blockNumber] = data;
                    if (blockNumber % 100 === 0) {
                        console.log(`  Fetched block ${blockNumber} (${Object.keys(batchData).length}/${BLOCKS_PER_FILE})`);
                    }
                }
            })
        );
    }

    await Promise.all(promises);

    // Save batch to file with zstd compression
    const jsonData = JSON.stringify(batchData);
    const compressed = await zstd.compress(Buffer.from(jsonData));
    await fs.writeFile(filePath, compressed);
    console.log(`✓ Saved ${Object.keys(batchData).length} blocks to ${filePath}`);

    return Object.keys(batchData).length;
}

// Main processing loop
async function main() {
    console.log('='.repeat(60));
    console.log('Block Data Fetcher');
    console.log('='.repeat(60));
    console.log(`RPC Endpoint: ${RPC_URL}`);
    console.log(`Start Block: ${START_BLOCK}`);
    console.log(`Blocks per file: ${BLOCKS_PER_FILE}`);
    console.log(`Concurrency: ${CONCURRENCY}`);
    console.log(`Data directory: ${DATA_DIR}`);

    // Get latest block
    const latestBlockHex = await client.request({
        method: 'eth_blockNumber',
        params: [],
    });
    const latestBlock = parseInt(latestBlockHex, 16);
    console.log(`Latest Block: ${latestBlock}`);
    console.log(`Total blocks to process: ${latestBlock - START_BLOCK + 1}`);

    console.log('='.repeat(60));

    await ensureDataDir();

    const startTime = Date.now();
    let currentBlock = START_BLOCK;
    let totalBlocksProcessed = 0;

    while (true) {
        const batchStartTime = Date.now();
        const blocksInBatch = await processBatch(currentBlock);
        const batchTime = (Date.now() - batchStartTime) / 1000;

        totalBlocksProcessed += blocksInBatch;
        const totalTime = (Date.now() - startTime) / 1000;
        const avgSpeed = (totalBlocksProcessed / totalTime).toFixed(2);

        // Calculate time remaining
        const blocksRemaining = latestBlock - currentBlock;
        const hoursRemaining = (blocksRemaining / parseFloat(avgSpeed)) / 3600;

        console.log(`  Batch completed in ${batchTime.toFixed(1)}s | Total: ${totalBlocksProcessed} blocks | Avg: ${avgSpeed} blocks/s | ETA: ${hoursRemaining.toFixed(1)}h\n`);

        currentBlock += BLOCKS_PER_FILE;

        // Optional: Add a small delay between batches to avoid overwhelming the RPC
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\nReceived SIGINT, shutting down gracefully...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\nReceived SIGTERM, shutting down gracefully...');
    process.exit(0);
});

main();
