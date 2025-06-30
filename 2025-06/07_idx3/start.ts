import cluster from 'node:cluster';
import fs from 'node:fs';
import path from 'node:path';
import { BlockDB } from './blockFetcher/BlockDB';
import { startFetchingLoop } from './blockFetcher/startFetchingLoop';
import { BatchRpc } from './blockFetcher/BatchRpc';
import { createRPCIndexer } from './indexers/rpc';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { executePragmas, IndexingDbHelper } from './indexers/dbHelper';

import { IS_DEVELOPMENT, RPC_URL, CHAIN_ID, DATA_DIR, RPS, REQUEST_BATCH_SIZE, MAX_CONCURRENT, BLOCKS_PER_BATCH } from './config';
import { createSanityChecker } from './indexers/sanityChecker';
import { createMetricsIndexer } from './indexers/metrics';
import { Indexer } from './indexers/types';

const blocksDbPath = path.join(DATA_DIR, CHAIN_ID, 'blocks.db');
const indexingDbPath = path.join(path.dirname(blocksDbPath), 'indexing.db');
if (!fs.existsSync(blocksDbPath)) {
    fs.mkdirSync(path.dirname(blocksDbPath), { recursive: true });
}

const indexerFactories = [createRPCIndexer, createMetricsIndexer];
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
            batchSize: REQUEST_BATCH_SIZE,
            maxConcurrent: MAX_CONCURRENT,
            rps: RPS,
            enableBatchSizeGrowth: false,
        });
        startFetchingLoop(blocksDb, batchRpc, BLOCKS_PER_BATCH);
    } else if (process.env['ROLE'] === 'api') {
        //awaits both files as it is read only for both
        await awaitFileExists(indexingDbPath);
        await awaitFileExists(blocksDbPath);

        const blocksDb = new BlockDB({ path: blocksDbPath, isReadonly: true });
        const indexingDb = new Database(indexingDbPath, { readonly: true });

        const evmChainId = await waitForChainId(blocksDb);

        await executePragmas({ db: indexingDb, isReadonly: true });

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
            //metrics are v2, data is v1
            fastifyApp.register((fastify, options) => indexer.registerRoutes(fastify, options), {
                prefix: `/${indexer.getVersionPrefix()}/chains/${evmChainId}`
            });
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
        const indexers: Indexer[] = indexerFactories.map(factory => {
            const indexer = factory(blocksDb, indexingDb);
            indexer.initialize();
            return indexer;
        });

        await executePragmas({ db: indexingDb, isReadonly: false });

        let hadSomethingToIndex = false;

        const runIndexing = indexingDb.transaction((lastIndexedBlock) => {
            const getStart = performance.now();
            const blocks = blocksDb.getBlocks(lastIndexedBlock + 1, BLOCKS_PER_BATCH);
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

async function waitForChainId(blocksDb: BlockDB, maxAttempts: number = 10): Promise<number> {
    let attempts = 0;
    while (blocksDb.getEvmChainId() === -1) {
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
        if (attempts > maxAttempts) {
            throw new Error('Failed to get chain id');
        }
    }
    return blocksDb.getEvmChainId();
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
