import cluster from 'node:cluster';
import fs from 'node:fs';
import path from 'node:path';
import { BlockDB } from './blockFetcher/BlockDB';
import { startFetchingLoop } from './blockFetcher/startFetchingLoop';
import { BatchRpc } from './blockFetcher/BatchRpc';
import { createRPCIndexer } from './indexers/rpc';
import fastify from 'fastify';
import Database from 'better-sqlite3';

const RPC_URL = 'http://65.21.140.118/ext/bc/2XCTEc8CfNK9MtQWYMfgNt32QjZsZqq92LH7eTV5xY8YjY44du/rpc'
const CHAIN_ID = '2XCTEc8CfNK9MtQWYMfgNt32QjZsZqq92LH7eTV5xY8YjY44du'

const blocksDbPath = path.join("database", CHAIN_ID, 'blocks.db');
if (!fs.existsSync(blocksDbPath)) {
    fs.mkdirSync(path.dirname(blocksDbPath), { recursive: true });
}

if (cluster.isPrimary) {
    // spawn one writer, one reader, one misc-job worker
    cluster.fork({ ROLE: 'fetcher' });
    cluster.fork({ ROLE: 'api' });
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
        startFetchingLoop(blocksDb, batchRpc, 10);
    } else if (process.env['ROLE'] === 'api') {
        const blocksDb = new BlockDB(blocksDbPath, false);
        const indexingDb = new Database(path.join("database", CHAIN_ID, 'indexing.db'));
        const indexerFactories = [createRPCIndexer];
        const fastifyApp = fastify({ logger: true });

        for (const indexerFactory of indexerFactories) {
            const indexer = indexerFactory(blocksDb, indexingDb);
            fastifyApp.register((fastify, options) => indexer.registerRoutes(fastify, options));
        }

        fastifyApp.listen({ port: 3000 }, (err, address) => {
            if (err) {
                fastifyApp.log.error(err);
                process.exit(1);
            }
            fastifyApp.log.info(`server listening on ${address}`);
        });
    } else {
        throw new Error('unknown role');
    }
}
