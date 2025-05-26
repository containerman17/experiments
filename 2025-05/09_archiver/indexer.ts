import { BatchRpc, fetchBlockchainIDFromPrecompile } from "./rpc/rpc.ts"
import type { StoredBlock } from "./rpc/types.ts";
import type { Hex, Transaction, TransactionReceipt } from 'viem';
import { encode } from 'cbor2';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { FileBlockStore } from "./rpc/fileCache.ts";
import { initializeDatabase, Database } from "./database/db.ts";

dotenv.config();

const interval_seconds = 1; // Default polling interval

const rpcUrl = process.env.RPC_URL;
if (!rpcUrl) {
    console.error("RPC_URL environment variable is not set.");
    process.exit(1);
}
const blockchainID = await fetchBlockchainIDFromPrecompile(rpcUrl);

import { mkdir } from 'node:fs/promises';
import { SqliteBlockStore } from "./rpc/sqliteCache.ts";
import { startAPI } from "./api.ts";
import { IndexerAPI } from "./indexerAPI.ts";
await mkdir(`./data/${blockchainID}`, { recursive: true });

const rawDb = initializeDatabase(blockchainID);
const db = new Database(rawDb);


//This function is guaranteed to be called in order and inside a transaction
function handleBlock({ block, receipts }: StoredBlock) {
    if (Number(block.number) % 100 === 0) {
        console.log('handleBlock', Number(block.number), `with ${Object.keys(receipts).length} receipts`)
    }
    // console.log('handleBlock', Number(block.number))
    for (const tx of block.transactions) {
        db.insertTxBlockLookup(tx.hash, Number(block.number))
    }
    db.updateConfig('last_processed_block', Number(block.number).toString())
    db.recordTxCount(Object.keys(receipts).length, Number(block.timestamp))
}


const isLocal = process.env.RPC_URL?.includes('localhost') || process.env.RPC_URL?.includes('127.0.0.1')

const PROCESSING_BATCH_SIZE = isLocal ? 10000 : 1000; // Number of blocks to fetch and process per cycle

// const cacher = new FileBlockStore(`./data/${blockchainID}/blocks/`); // This is the BlockCache instance
const cacher = new SqliteBlockStore(`./data/${blockchainID}/blocks.sqlite`); // This is the BlockCache instance

const concurrency = isLocal ? 100 : 10
const rpc = new BatchRpc({
    rpcUrl,
    cache: cacher,
    maxBatchSize: isLocal ? 100 : 100,
    maxConcurrency: concurrency,
    rps: concurrency * (isLocal ? 10 : 2)
});


async function startLoop() {
    console.log('Starting indexer loop...');

    while (true) {
        const start = performance.now();

        const latestBlock = await rpc.getCurrentBlockNumber();

        const lastProcessedBlock = db.getConfig('last_processed_block');
        let currentBlockToProcess = parseInt(lastProcessedBlock || '-1') + 1;

        console.log(`Loop iteration. Current block to process: ${currentBlockToProcess}, Latest block from RPC: ${latestBlock}`);

        if (currentBlockToProcess > latestBlock) {
            await new Promise(resolve => setTimeout(resolve, interval_seconds * 1000));
            continue;
        }

        const blockNumbersToFetch: number[] = [];
        const endRange = Math.min(latestBlock, currentBlockToProcess + PROCESSING_BATCH_SIZE - 1);

        for (let i = currentBlockToProcess; i <= endRange; i++) {
            blockNumbersToFetch.push(i);
        }

        if (blockNumbersToFetch.length === 0) {
            // This might happen if latestBlock was equal to currentBlockToProcess - 1, covered by the previous check.
            console.log('No new blocks to fetch in this range. Waiting...');
            await new Promise(resolve => setTimeout(resolve, interval_seconds * 1000));
            continue;
        }

        console.log(`Attempting to fetch ${blockNumbersToFetch.length} blocks: from ${blockNumbersToFetch[0]} to ${blockNumbersToFetch[blockNumbersToFetch.length - 1]}`);

        try {
            const fetchedBlocks = await rpc.getBlocksWithReceipts(blockNumbersToFetch);

            if (fetchedBlocks.length > 0) {
                console.log(`Received ${fetchedBlocks.length} blocks. Processing them in a transaction.`);

                const txStart = performance.now();
                db.transaction(() => {
                    for (const block of fetchedBlocks) {
                        // handleBlock updates 'last_processed_block' in the DB for each block
                        handleBlock(block);
                    }
                });
                console.log(`Time taken to process ${fetchedBlocks.length} blocks: ${performance.now() - txStart}ms`);
                console.log(`Successfully processed batch. Last block in DB should now be updated by handleBlock.`);
            } else if (blockNumbersToFetch.length > 0) {
                console.warn(`Requested ${blockNumbersToFetch.length} blocks, but received 0. Possible gap or RPC issue. Waiting before retry.`);
                await new Promise(resolve => setTimeout(resolve, 2000)); // Short delay before retrying loop
            }
            // If fetchedBlocks.length is 0 and blockNumbersToFetch.length was also 0, earlier continue handles it.

        } catch (error) {
            console.error(`Error during block fetching or processing batch starting from ${blockNumbersToFetch[0]}:`, error);
            console.log('Waiting before retrying...');
            await new Promise(resolve => setTimeout(resolve, interval_seconds * 1000));
        }

        const end = performance.now();
        console.log(`Time taken: ${end - start}ms`);
    }
}

startLoop().catch(error => {
    console.error("Critical error in startLoop:", error);
    process.exit(1);
});

const indexer = new IndexerAPI(db, rpc);


startAPI(indexer).catch(error => {
    console.error("Critical error in startAPI:", error);
    process.exit(1);
});
