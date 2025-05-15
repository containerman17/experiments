import dotenv from "dotenv"
dotenv.config()

import { BatchRpc } from "./rpc/rpc.ts"

const rpc = new BatchRpc(process.env.RPC_URL!, 25)

for (let i = 0; i < 10; i++) {
    console.time(`test ${i}`)
    const blocksCount = 1000
    const blockNumbers = Array.from({ length: blocksCount }, (_, j) => i * 10 + j)
    const blocks = await rpc.getBlocksWithReceipts(blockNumbers)
    console.timeEnd(`test ${i}`)
}


// import { RPC } from "./rpc/rpc.ts"
// import { S3BlockStore } from "./rpc/s3cache.ts";
// import { CachedRPC } from "./rpc/cachedRpc.ts";
// import { rpcSchema, toBytes } from 'viem'
// import Database from 'better-sqlite3';
// import { BlockCache, StoredBlock } from "./rpc/types.ts";
// const db = new Database('/tmp/foobar2.db');
// db.pragma('journal_mode = WAL');

// db.exec('CREATE TABLE IF NOT EXISTS tx_block_lookup (hash_to_block BLOB PRIMARY KEY) WITHOUT ROWID;');
// db.exec('CREATE TABLE IF NOT EXISTS configs (key TEXT PRIMARY KEY, value TEXT)');
// db.prepare('INSERT OR IGNORE INTO configs (key, value) VALUES (?, ?)').run('last_processed_block', '-1');



// let indexedRecently = 0
// const interval_seconds = 5
// setInterval(() => {
//     console.log(`Indexing ${indexedRecently / interval_seconds} tx/s`)
//     indexedRecently = 0
// }, interval_seconds * 1000)

// //This function is guaranteed to be called in order and inside a transaction
// function handleBlock({ block, receipts }: StoredBlock) {
//     if (Number(block.number) % 100 === 0) {
//         console.log('handleBlock', Number(block.number))
//     }
//     // console.log('handleBlock', Number(block.number))
//     for (const tx of block.transactions) {
//         const txHashBytes = toBytes(tx.hash)
//         const lookupKey = Buffer.from([...txHashBytes.slice(0, 5), ...toBytes(Number(block.number))])
//         db.prepare('INSERT INTO tx_block_lookup (hash_to_block) VALUES (?) ON CONFLICT(hash_to_block) DO NOTHING').run(lookupKey)
//     }
//     db.prepare('UPDATE configs SET value = ? WHERE key = ?').run(Number(block.number), 'last_processed_block')
//     indexedRecently++
// }

// async function startLoop() {
//     const uncachedRPC = new RPC(process.env.RPC_URL!, 10, 50); // maxBatchSize 10, batchInterval 150ms
//     await uncachedRPC.loadChainId(); // It's good practice to load the chainId early if needed elsewhere
//     const chainIdbase58 = await uncachedRPC.getBlockchainIDFromPrecompile()
//     const cacher = new S3BlockStore(chainIdbase58)
//     const cachedRPC = new CachedRPC(cacher, uncachedRPC)

//     const lastProcessedBlockResp = db.prepare('SELECT value FROM configs WHERE key = ?').get('last_processed_block') as { value: string }
//     const lastProcessedBlock = parseInt(lastProcessedBlockResp.value)
//     console.log('lastProcessedBlock', lastProcessedBlock)
//     let currentBlock = lastProcessedBlock + 1

//     let blockPromises: Record<number, Promise<StoredBlock> | null> = {}
//     let latestBlock = await uncachedRPC.getCurrentBlockNumber()
//     console.log('latestBlock', latestBlock)
//     for (let i = currentBlock; i < latestBlock; i++) {
//         //prefill with future block promises
//         const CACHE_DEPTH = 30
//         for (let j = i; j < i + CACHE_DEPTH; j++) {
//             if (!blockPromises[j]) {
//                 blockPromises[j] = cachedRPC.getBlock(j)
//             }
//         }

//         const block = await blockPromises[i]
//         if (!block) {
//             throw new Error(`Block ${i} not found`)
//         }
//         db.transaction(() => {
//             handleBlock(block)
//         })()
//         currentBlock++
//     }

//     console.log('done')
// }

// startLoop()
