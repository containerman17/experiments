import * as fs from 'node:fs';
import * as path from 'node:path';
import { Buffer } from 'node:buffer';
import Database from 'better-sqlite3';
import { RPC } from './rpc/rpc';
import { CachedRPC } from './rpc/cachedRpc';
import { S3BlockStore } from './rpc/s3';
import dotenv from 'dotenv';
import { StoredBlock } from './rpc/types';

dotenv.config();

const sqliteDb = new Database(':memory:');//new Database('my-db.sqlite');
sqliteDb.pragma('journal_mode = WAL');

//KV table
sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value ANY
  )
`);
sqliteDb.prepare('INSERT OR IGNORE INTO kv (key, value) VALUES (?, ?)').run('last_indexed_block', -1);

//tx_lookup table. loosely connects tx prefix to a block number
sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS tx_lookup (
    value BLOB PRIMARY KEY
  ) 
`);

// Prepare statement for tx_lookup insertions
const insertTxLookup = sqliteDb.prepare('INSERT OR IGNORE INTO tx_lookup (value) VALUES (?)');

const processBlockTxs = sqliteDb.transaction((blockData: StoredBlock) => {
    const blockNumber = Number(blockData.block.number);

    for (const tx of blockData.block.transactions) {

        if (tx && typeof tx.hash === 'string' && tx.hash.startsWith('0x')) {
            const txHashString = tx.hash;
            const hexHash = txHashString.substring(2);

            if (hexHash.length === 0) { // Handles '0x' case
                throw new Error(`Transaction hash is empty after removing '0x': ${txHashString} in block ${blockNumber}`);
            }

            const fullHashBuffer = Buffer.from(hexHash, 'hex');

            if (fullHashBuffer.length < 5) {
                throw new Error(`Transaction hash converts to less than 5 bytes: ${txHashString} (got ${fullHashBuffer.length} bytes) in block ${blockNumber}`);
            }

            const prefix = fullHashBuffer.subarray(0, 5);

            const actualBlockNumberBigInt = blockData.block.number;
            if (actualBlockNumberBigInt === null) {
                throw new Error(`Block number is unexpectedly null in block data for block hash ${blockData.block.hash}`);
            }
            const blockNumHex = actualBlockNumberBigInt.toString(16);
            // Ensure hex string has even length for Buffer.from(..., 'hex')
            const paddedBlockNumHex = blockNumHex.length % 2 === 0 ? blockNumHex : '0' + blockNumHex;
            const blockNumBuffer = Buffer.from(paddedBlockNumHex, 'hex');

            const lookupKey = Buffer.concat([prefix, blockNumBuffer]);
            insertTxLookup.run(lookupKey);
        } else {
            throw new Error(`Skipping transaction with invalid or missing hash in block ${blockNumber}: ${JSON.stringify(tx)}`);
        }
    }
});

async function startIndexingLoop() {
    const rpc = new RPC(process.env.RPC_URL!);
    const cachedRpc = new CachedRPC(new S3BlockStore('avalanche-mainnet-blocks'), rpc);

    const lastIndexedBlock = (sqliteDb.prepare('SELECT value FROM kv WHERE key = ?').get('last_indexed_block') as { value: number }).value;
    let currentBlock = lastIndexedBlock + 1;

    let lastBlock = await rpc.getCurrentBlockNumber();

    while (currentBlock <= lastBlock) {
        const fetchStart = performance.now();
        const blockData = await cachedRpc.fetchBlockAndReceipts(currentBlock);
        const fetchEnd = performance.now();

        const processingStart = performance.now();
        processBlockTxs(blockData);
        const processingEnd = performance.now();

        console.log(`Block ${currentBlock}/${lastBlock}: fetched in ${(fetchEnd - fetchStart).toFixed(2)}ms, processed in ${(processingEnd - processingStart).toFixed(2)}ms. Tx count: ${blockData?.block?.transactions?.length || 0}`);
        currentBlock++;
    }
}

startIndexingLoop();
