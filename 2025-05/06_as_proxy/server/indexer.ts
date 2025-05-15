import { RPC } from "./rpc/rpc.ts"
import dotenv from "dotenv"
import { S3BlockStore } from "./rpc/s3cache.ts";
import { CachedRPC } from "./rpc/cachedRpc.ts";
import { toBytes } from 'viem'
import Database from 'better-sqlite3';
import { StoredBlock } from "./rpc/types.ts";
const db = new Database('/tmp/foobar.db');
db.pragma('journal_mode = WAL');

db.exec('CREATE TABLE IF NOT EXISTS tx_block_lookup (hash_to_block BLOB PRIMARY KEY) WITHOUT ROWID;');
db.exec('CREATE TABLE IF NOT EXISTS configs (key TEXT PRIMARY KEY, value TEXT)');
db.prepare('INSERT OR IGNORE INTO configs (key, value) VALUES (?, ?)').run('last_processed_block', '-1');


dotenv.config()

//This function is guaranteed to be called in order and inside a transaction
function handleBlock({ block, receipts }: StoredBlock) {
    console.log(`Block ${Number(block.number)} has ${Object.keys(receipts).length} receipts`)
    for (const tx of block.transactions) {
        const txHashBytes = toBytes(tx.hash)
        const lookupKey = Buffer.from([...txHashBytes.slice(0, 5), ...toBytes(Number(block.number))])
        db.prepare('INSERT INTO tx_block_lookup (hash_to_block) VALUES (?)').run(lookupKey)
        db.prepare('UPDATE configs SET value = ? WHERE key = ?').run(Number(block.number), 'last_processed_block')
    }
}

async function startLoop() {
    const uncachedRPC = new RPC(process.env.RPC_URL!);
    const chainIdbase58 = await uncachedRPC.getBlockchainIDFromPrecompile()
    const cacher = new S3BlockStore(chainIdbase58)
    const cachedRPC = new CachedRPC(cacher, uncachedRPC)

    const lastProcessedBlockResp = db.prepare('SELECT value FROM configs WHERE key = ?').get('last_processed_block') as { value: string }
    const lastProcessedBlock = parseInt(lastProcessedBlockResp.value)
    console.log('lastProcessedBlock', lastProcessedBlock)
    let currentBlock = lastProcessedBlock + 1

    for (let i = currentBlock; i < 300; i++) {
        const block = await cachedRPC.getBlock(currentBlock)
        currentBlock++
        db.transaction((cats) => {
            handleBlock(block)
        })()
    }
}

startLoop()
