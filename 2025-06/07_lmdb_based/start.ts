import cluster from 'node:cluster';
import fs from 'node:fs';
import path from 'node:path';
import { BlockDB } from './blockFetcher/BlockDB';
import { startFetchingLoop } from './blockFetcher/startFetchingLoop';
import { BatchRpc } from './blockFetcher/BatchRpc';
import { createRPCIndexer } from './indexers/rpc';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { IndexingDbHelper } from './indexers/dbHelper';
import { config } from 'node:process';
import { IS_DEVELOPMENT } from './config';
import { createSanityChecker } from './indexers/sanityChecker';

const RPC_URL = 'http://65.21.140.118/ext/bc/2XCTEc8CfNK9MtQWYMfgNt32QjZsZqq92LH7eTV5xY8YjY44du/rpc'
const CHAIN_ID = '2XCTEc8CfNK9MtQWYMfgNt32QjZsZqq92LH7eTV5xY8YjY44du'

const blocksDbPath = path.join("database", CHAIN_ID, 'blocks.db');
const indexingDbPath = path.join(path.dirname(blocksDbPath), 'indexing.db');
if (!fs.existsSync(blocksDbPath)) {
    fs.mkdirSync(path.dirname(blocksDbPath), { recursive: true });
}

const indexerFactories = [createRPCIndexer];
if (IS_DEVELOPMENT) {
    indexerFactories.push(createSanityChecker);
}

if (cluster.isPrimary) {
    // spawn one writer, one reader, one misc-job worker
    cluster.fork({ ROLE: 'fetcher' });
    cluster.fork({ ROLE: 'api' });
    cluster.fork({ ROLE: 'indexer' });
} else {
    if (process.env['ROLE'] === 'fetcher') {
        const blocksDb = new BlockDB({ path: blocksDbPath, isReadonly: false });
        const batchRpc = new BatchRpc({
            rpcUrl: RPC_URL,
            batchSize: 500,
            maxConcurrent: 10,
            rps: 100,
            enableBatchSizeGrowth: false,
        });
        startFetchingLoop(blocksDb, batchRpc, 1000);
    } else if (process.env['ROLE'] === 'api') {
        //awaits both files as it is read only for both
        await awaitFileExists(indexingDbPath);
        await awaitFileExists(blocksDbPath);

        const blocksDb = new BlockDB({ path: blocksDbPath, isReadonly: true });
        const indexingDb = new Database(indexingDbPath, { readonly: true });

        const fastifyApp = Fastify({
            logger: {
                transport: {
                    // plain-text output, colourised, one line per log
                    target: 'pino-pretty',
                    options: {
                        translateTime: 'HH:MM:ss',
                        singleLine: true,
                        ignore: 'pid,hostname'   // keep it short
                    }
                },
                level: process.env['LOG_LEVEL'] || 'info'
            }
        })

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
    } else if (process.env['ROLE'] === 'indexer') {
        await awaitFileExists(blocksDbPath);

        const blocksDb = new BlockDB({ path: blocksDbPath, isReadonly: true });
        const indexingDb = new Database(indexingDbPath, { readonly: false });
        const indexingDbHelper = new IndexingDbHelper(indexingDb);
        const indexers = indexerFactories.map(factory => factory(blocksDb, indexingDb));

        let hadSomethingToIndex = false;

        // Create the transaction function ONCE
        const runIndexing = indexingDb.transaction((lastIndexedBlock) => {
            const getStart = performance.now();
            const blocks = blocksDb.getBlocks(lastIndexedBlock + 1, 10000);
            const indexingStart = performance.now();
            hadSomethingToIndex = blocks.length > 0;
            let debugTxCount = 0
            if (hadSomethingToIndex) {
                for (const { block, txs } of blocks) {
                    debugTxCount += txs.length;
                    for (const indexer of indexers) {
                        indexer.indexBlock(block, txs);
                    }
                }
                const indexingFinish = performance.now();
                indexingDbHelper.setInteger('lastIndexedBlock', blocks[blocks.length - 1]!.block.number);
                console.log('Got', debugTxCount, 'txs in', Math.round(indexingStart - getStart), 'ms', 'indexing', Math.round(indexingFinish - indexingStart), 'ms');
            }
        });

        while (true) {
            runIndexing(indexingDbHelper.getInteger('lastIndexedBlock', -1));
            if (!hadSomethingToIndex) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        process.exit(1);
    } else {
        throw new Error('unknown role');
    }
}


async function awaitFileExists(path: string, maxMs: number = 3 * 1000, intervalMs: number = 100) {
    const startTime = Date.now();
    while (true) {
        if (fs.existsSync(path)) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
        if (Date.now() - startTime > maxMs) {
            throw new Error(`File ${path} did not exist after ${maxMs} ms`);
        }
    }
}
