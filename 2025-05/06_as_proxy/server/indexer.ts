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

dotenv.config()

//This function is guaranteed to be called in order and inside a transaction
function handleBlock({ block, receipts }: StoredBlock) {
    console.log(`Block ${Number(block.number)} has ${Object.keys(receipts).length} receipts`)
    for (const tx of block.transactions) {
        const txHashBytes = toBytes(tx.hash)
        const lookupKey = Buffer.from([...txHashBytes.slice(0, 5), ...toBytes(Number(block.number))])
        db.prepare('INSERT INTO tx_block_lookup (hash_to_block) VALUES (?)').run(lookupKey)
    }
}

async function startLoop() {
    const uncachedRPC = new RPC(process.env.RPC_URL!);
    const chainIdbase58 = await uncachedRPC.getBlockchainIDFromPrecompile()
    const cacher = new S3BlockStore(chainIdbase58)
    const cachedRPC = new CachedRPC(cacher, uncachedRPC)

    let currentBlock = 100

    for (let i = currentBlock; i < (260); i++) {
        const block = await cachedRPC.getBlock(currentBlock)
        currentBlock++
        const runTx = db.transaction((cats) => {
            handleBlock(block)
        });
        runTx()
    }
}

startLoop()
