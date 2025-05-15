import dotenv from "dotenv"
dotenv.config()


import { BatchRpc, fetchBlockchainIDFromPrecompile } from "./rpc/rpc.ts"
import { S3BlockStore } from "./rpc/s3cache.ts";
import { rpcSchema, toBytes } from 'viem'
import Database from 'better-sqlite3';
import { BlockCache, StoredBlock } from "./rpc/types.ts";
const db = new Database('/tmp/foobar2.db');
db.pragma('journal_mode = WAL');

db.exec('CREATE TABLE IF NOT EXISTS tx_block_lookup (hash_to_block BLOB PRIMARY KEY) WITHOUT ROWID;');
db.exec('CREATE TABLE IF NOT EXISTS configs (key TEXT PRIMARY KEY, value TEXT)');
db.prepare('INSERT OR IGNORE INTO configs (key, value) VALUES (?, ?)').run('last_processed_block', '-1');



let indexedRecently = 0
const interval_seconds = 10
setInterval(() => {
    console.log(`🔥 Indexing ${indexedRecently / interval_seconds} tx/s`)
    indexedRecently = 0
}, interval_seconds * 1000)

//This function is guaranteed to be called in order and inside a transaction
function handleBlock({ block, receipts }: StoredBlock) {
    if (Number(block.number) % 100 === 0) {
        console.log('handleBlock', Number(block.number))
    }
    // console.log('handleBlock', Number(block.number))
    for (const tx of block.transactions) {
        const txHashBytes = toBytes(tx.hash)
        // Using block.number which is typically a bigint from viem, ensure it's converted for toBytes if needed, though Number() should suffice for typical range.
        const lookupKey = Buffer.from([...txHashBytes.slice(0, 5), ...toBytes(Number(block.number))])
        db.prepare('INSERT INTO tx_block_lookup (hash_to_block) VALUES (?) ON CONFLICT(hash_to_block) DO NOTHING').run(lookupKey)
    }
    db.prepare('UPDATE configs SET value = ? WHERE key = ?').run(Number(block.number).toString(), 'last_processed_block')
    indexedRecently++
}

async function startLoop() {
    const rpcUrl = process.env.RPC_URL;
    if (!rpcUrl) {
        console.error("RPC_URL environment variable is not set.");
        process.exit(1);
    }

    const blockchainID = await fetchBlockchainIDFromPrecompile(rpcUrl);
    const cacher = new S3BlockStore(blockchainID); // This is the BlockCache instance

    // Corrected BatchRpc instantiation:
    // 1st arg: rpcUrl (string)
    // 2nd arg: cache (BlockCache instance)
    // 3rd arg: maxBatchSize for internal JSON-RPC batching (number, defaults to 25 if not provided)
    const rpc = new BatchRpc({
        rpcUrl,
        cache: cacher,
        maxBatchSize: 40,
        maxConcurrency: 20,
        rps: 20
    });

    const PROCESSING_BATCH_SIZE = 200; // Number of blocks to fetch and process per cycle

    console.log('Starting indexer loop...');

    while (true) {
        const latestBlock = await rpc.getCurrentBlockNumber();

        const lastProcessedBlockResp = db.prepare('SELECT value FROM configs WHERE key = ?').get('last_processed_block') as { value: string };
        let currentBlockToProcess = parseInt(lastProcessedBlockResp.value) + 1;

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
                db.transaction(() => {
                    for (const block of fetchedBlocks) {
                        // handleBlock updates 'last_processed_block' in the DB for each block
                        handleBlock(block);
                    }
                })();
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
    }
}

startLoop().catch(error => {
    console.error("Critical error in startLoop:", error);
    process.exit(1);
});
