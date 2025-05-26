import { BatchRpc, fetchBlockchainIDFromPrecompile } from "./rpc/rpc.ts"
import { toBytes } from 'viem'
import type { StoredBlock } from "./rpc/types.ts";
import type { Hex, Transaction, TransactionReceipt } from 'viem';
import { fromBytes, toBytes as viemToBytes } from 'viem';
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
        const txHashBytes = toBytes(tx.hash)
        // Using block.number which is typically a bigint from viem, ensure it's converted for toBytes if needed, though Number() should suffice for typical range.
        const lookupKey = Buffer.from([...txHashBytes.slice(0, 5), ...toBytes(Number(block.number))])
        db.insertTxBlockLookup(lookupKey)
    }
    db.updateConfig('last_processed_block', Number(block.number).toString())
}

export class IndexerAPI {
    private db: Database;
    private rpc: BatchRpc;

    constructor(database: Database, rpc: BatchRpc) {
        this.db = database;
        this.rpc = rpc;
    }

    async getTx(txHash: Hex): Promise<{ transaction: Transaction; receipt: TransactionReceipt; blockNumber: bigint } | null> {
        const fullTxHashBytes = viemToBytes(txHash);
        const prefixBytes = fullTxHashBytes.slice(0, 5);
        const prefixHex = Buffer.from(prefixBytes).toString('hex');

        const lookupKeyRows = this.db.getTxLookupByPrefix(prefixHex);

        if (lookupKeyRows.length === 0) {
            return null;
        }

        const potentialBlockNumbers = new Set<number>();
        for (const row of lookupKeyRows) {
            const lookupKeyBlob = row.hash_to_block;
            // Ensure lookupKeyBlob is long enough (prefix + at least 1 byte for number)
            if (lookupKeyBlob.length > 5) {
                const blockNumberBytes = lookupKeyBlob.slice(5);
                try {
                    // fromBytes expects Uint8Array. Buffer is a Uint8Array subclass.
                    const blockNumber = fromBytes(blockNumberBytes, 'number');
                    potentialBlockNumbers.add(blockNumber);
                } catch (e) {
                    console.error(`Error parsing block number from lookup key ${lookupKeyBlob.toString('hex')}:`, e);
                }
            }
        }

        if (potentialBlockNumbers.size === 0) {
            return null;
        }

        const blockNumbersToFetch = Array.from(potentialBlockNumbers);
        // Sort to fetch in order, though not strictly necessary for correctness here
        blockNumbersToFetch.sort((a, b) => a - b);

        const fetchedBlocksData = await this.rpc.getBlocksWithReceipts(blockNumbersToFetch);

        for (const storedBlock of fetchedBlocksData) {
            if (storedBlock && storedBlock.block && storedBlock.block.transactions && storedBlock.receipts) {
                for (let i = 0; i < storedBlock.block.transactions.length; i++) {
                    const tx = storedBlock.block.transactions[i];
                    if (tx && tx.hash === txHash) {
                        const receipt = storedBlock.receipts[txHash];
                        if (receipt) {
                            return {
                                transaction: tx as Transaction,
                                receipt: receipt,
                                blockNumber: storedBlock.block.number
                            };
                        }
                    }
                }
            }
        }
        return null;
    }
}


const isLocal = process.env.RPC_URL?.includes('localhost') || process.env.RPC_URL?.includes('127.0.0.1')

const PROCESSING_BATCH_SIZE = isLocal ? 10000 : 100; // Number of blocks to fetch and process per cycle

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

const indexer = new IndexerAPI(db, rpc);

async function startLoop() {
    console.log('Starting indexer loop...');

    while (true) {
        const start = performance.now();

        const latestBlock = await rpc.getCurrentBlockNumber();

        const lastProcessedBlock = db.getConfig('last_processed_block');
        let currentBlockToProcess = parseInt(lastProcessedBlock || '-1') + 1;

        console.log(`Loop iteration. Current block to process: ${currentBlockToProcess}, Latest block from RPC: ${latestBlock}`);

        if (currentBlockToProcess > latestBlock) {
            console.log(`Caught up to the latest block (${latestBlock}). Waiting for new blocks...`);
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

                // Compression comparison
                for (const block of fetchedBlocks) {
                    if (Object.keys(block.receipts).length > 1) {
                        fs.writeFileSync(`./compression_bench.cbor2`, encode(block.receipts));
                    }
                }

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
