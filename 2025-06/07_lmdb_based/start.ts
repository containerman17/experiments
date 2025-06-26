import cluster from 'node:cluster';
import fs from 'node:fs';
import path from 'node:path';
import { BlockDB } from './blockFetcher/BlockDB';
import { startFetchingLoop } from './blockFetcher/startFetchingLoop';
import { BatchRpc } from './blockFetcher/BatchRpc';

const RPC_URL = 'https://meganode.solokhin.com/ext/bc/25friWasfe2pMdVHQAh5inDBz5XQq42a1V8DYqAGnxeKks5Bkp/rpc'
const CHAIN_ID = '25friWasfe2pMdVHQAh5inDBz5XQq42a1V8DYqAGnxeKks5Bkp'

const blocksDbPath = path.join("database", CHAIN_ID, 'blocks.db');
if (!fs.existsSync(blocksDbPath)) {
    fs.mkdirSync(path.dirname(blocksDbPath), { recursive: true });
}


if (cluster.isPrimary) {
    // spawn one writer, one reader, one misc-job worker
    cluster.fork({ ROLE: 'fetcher' });
} else {
    if (process.env['ROLE'] === 'fetcher') {
        const blocksDb = new BlockDB(blocksDbPath, true);
        const batchRpc = new BatchRpc({
            rpcUrl: RPC_URL,
            batchSize: 100,
            maxConcurrent: 100,
            rps: 100,
            enableBatchSizeGrowth: false,
        });
        startFetchingLoop(blocksDb, batchRpc, 1000);
    } else {
        throw new Error('unknown role');
    }
}
