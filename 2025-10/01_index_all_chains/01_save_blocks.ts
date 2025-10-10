import { createClient, http, rpcSchema } from 'viem';
import { getBlock, getTransactionReceipt, getBlockNumber } from 'viem/actions';
import pLimit from 'p-limit';
import type { IngestBlockParams, TraceResult, CallTrace } from './types.ts';
import { createClient as createClickHouseClient } from '@clickhouse/client';
import { formatBlockNumber, START_BLOCK } from './const.ts';

// Custom RPC schema for debug methods
type DebugRpcSchema = [
    {
        Method: 'debug_traceBlockByNumber';
        Parameters: [string, { tracer: string }];
        ReturnType: CallTrace[];
    }
];

const RPC_URL = 'http://localhost:9650/ext/bc/C/rpc';
const RPC_CONCURRENCY = 200; // For regular RPC calls (blocks, receipts)
const DEBUG_CONCURRENCY = 40; // For debug trace calls
const BATCH_SIZE = 1000;
const CLICKHOUSE_HOST = 'http://localhost:8123';
const CLICKHOUSE_DATABASE = 'default';
const CLICKHOUSE_PASSWORD = 'nopassword';

// Create custom client with debug trace functionality
const viemClient = createClient({
    transport: http(RPC_URL, {
        timeout: 300_000, // 5 minutes
    }),
    rpcSchema: rpcSchema<DebugRpcSchema>(),
}).extend(client => ({
    async traceBlockByNumber(blockNumber: bigint, tracer: string = 'callTracer') {
        return client.request({
            method: 'debug_traceBlockByNumber',
            params: [`0x${blockNumber.toString(16)}`, { tracer }]
        });
    },
}));

// Create ClickHouse client
const clickhouse = createClickHouseClient({
    host: CLICKHOUSE_HOST,
    database: CLICKHOUSE_DATABASE,
    password: CLICKHOUSE_PASSWORD,
});

const rpcLimit = pLimit(RPC_CONCURRENCY);
const debugLimit = pLimit(DEBUG_CONCURRENCY);

// Initialize ClickHouse table with EmbeddedRocksDB engine
async function initializeDatabase() {
    await clickhouse.exec({
        query: `
            CREATE TABLE IF NOT EXISTS blocks_data (
                block_number String,
                data String
            ) ENGINE = EmbeddedRocksDB
            PRIMARY KEY block_number
        `
    });
    console.log('Database initialized with EmbeddedRocksDB engine');
}

// Get the last saved block number
async function getLastSavedBlock(): Promise<number> {
    try {
        const result = await clickhouse.query({
            query: "SELECT data FROM blocks_data WHERE block_number = 'last_block'",
        });
        const data = await result.json<{ data: string }>();
        const lastBlockValue = data.data[0]?.data;

        if (lastBlockValue) {
            return parseInt(lastBlockValue, 10);
        }

        return 0;
    } catch (error) {
        console.log('No existing blocks found, starting from beginning');
        return 0;
    }
}

// Fetch complete block data including transactions, receipts, and traces
async function fetchBlockData(blockNumber: number): Promise<IngestBlockParams> {
    try {
        // Fetch block with full transactions (use rpcLimit)
        const block = await rpcLimit(() => getBlock(viemClient, {
            blockNumber: BigInt(blockNumber),
            includeTransactions: true,
        }));

        if (!block || !block.transactions) {
            throw new Error(`Block ${blockNumber} returned null or has no transactions field`);
        }

        // Fetch receipts and traces in parallel (they don't depend on each other)
        const [receipts, blockTraces] = await Promise.all([
            // Fetch all transaction receipts (use rpcLimit)
            Promise.all(
                block.transactions.map(tx =>
                    rpcLimit(() => getTransactionReceipt(viemClient, { hash: tx.hash }))
                )
            ),
            // Trace entire block at once (use debugLimit for heavy debug calls)
            debugLimit(() => viemClient.traceBlockByNumber(BigInt(blockNumber)))
        ]);

        // Map traces back to transaction hashes to maintain the same data structure
        const traces = block.transactions.map((tx, index) => ({
            txHash: tx.hash as string,
            result: blockTraces[index]
        }));

        return {
            transactions: block.transactions,
            traces,
            receipts
        };
    } catch (error: any) {
        console.error(`Error fetching block ${blockNumber}:`, error);
        throw error;
    }
}

// Save multiple blocks data to ClickHouse in a single insert
async function saveBlocksBatch(blocks: Array<{ blockNumber: number, data: IngestBlockParams }>): Promise<void> {
    const values = blocks.map(({ blockNumber, data }) => {
        const key = formatBlockNumber(blockNumber);
        const jsonData = JSON.stringify(data, (key, value) =>
            typeof value === 'bigint' ? value.toString() : value
        );
        return { block_number: key, data: jsonData };
    });

    await clickhouse.insert({
        table: 'blocks_data',
        values,
        format: 'JSONEachRow',
    });

    // Update the last_block key with the maximum block number from this batch
    const maxBlockInBatch = Math.max(...blocks.map(b => b.blockNumber));
    await clickhouse.insert({
        table: 'blocks_data',
        values: [{ block_number: 'last_block', data: maxBlockInBatch.toString() }],
        format: 'JSONEachRow',
    });
}

// Process a batch of blocks
async function processBatch(startBlock: number, endBlock: number): Promise<{ blocksProcessed: number, txCount: number }> {
    console.log(`Processing batch: blocks ${startBlock} to ${endBlock}`);

    // Fetch all blocks in parallel
    const fetchPromises: Promise<{ blockNumber: number, data: IngestBlockParams }>[] = [];

    for (let blockNumber = startBlock; blockNumber <= endBlock; blockNumber++) {
        fetchPromises.push(
            (async () => {
                const data = await fetchBlockData(blockNumber);
                return { blockNumber, data };
            })()
        );
    }

    const blocks = await Promise.all(fetchPromises);

    // Count total transactions in this batch
    const txCount = blocks.reduce((total, block) => total + block.data.transactions.length, 0);

    // Save all blocks in a single batch insert (atomic)
    await saveBlocksBatch(blocks);

    console.log(`  Saved blocks ${startBlock} to ${endBlock} (${txCount} transactions)`);

    return { blocksProcessed: endBlock - startBlock + 1, txCount };
}

// Main processing loop
async function main() {
    console.log('='.repeat(60));
    console.log('Block Data Fetcher & Saver');
    console.log('='.repeat(60));
    console.log(`RPC Endpoint: ${RPC_URL}`);
    console.log(`Start Block: ${START_BLOCK}`);
    console.log(`Batch size: ${BATCH_SIZE}`);
    console.log(`RPC Concurrency: ${RPC_CONCURRENCY}`);
    console.log(`Debug Concurrency: ${DEBUG_CONCURRENCY}`);
    console.log(`Storage: ClickHouse EmbeddedRocksDB`);

    // Get latest block
    const latestBlockHex = await getBlockNumber(viemClient);
    const latestBlock = Number(latestBlockHex);
    console.log(`Latest Block: ${latestBlock}`);

    await initializeDatabase();

    // Resume from last saved block
    const lastSavedBlock = await getLastSavedBlock();
    const startBlock = lastSavedBlock > 0 ? lastSavedBlock + 1 : START_BLOCK;

    console.log(`Total blocks to process: ${latestBlock - startBlock + 1}`);
    console.log('='.repeat(60));

    if (lastSavedBlock > 0) {
        console.log(`Resuming from block ${startBlock} (last saved: ${lastSavedBlock})\n`);
    }

    const startTime = Date.now();
    let currentBlock = startBlock;
    let totalBlocksProcessed = 0;
    let totalTxProcessed = 0;

    while (currentBlock <= latestBlock) {
        const batchStartTime = Date.now();
        const endBlock = Math.min(currentBlock + BATCH_SIZE - 1, latestBlock);
        const { blocksProcessed, txCount } = await processBatch(currentBlock, endBlock);
        const batchTime = (Date.now() - batchStartTime) / 1000;

        totalBlocksProcessed += blocksProcessed;
        totalTxProcessed += txCount;
        const totalTime = (Date.now() - startTime) / 1000;
        const avgBlockSpeed = (totalBlocksProcessed / totalTime).toFixed(2);
        const avgTxSpeed = (totalTxProcessed / totalTime).toFixed(2);

        // Calculate time remaining
        const blocksRemaining = latestBlock - endBlock;
        const hoursRemaining = (blocksRemaining / parseFloat(avgBlockSpeed)) / 3600;

        console.log(`  Batch completed in ${batchTime.toFixed(1)}s | Total: ${totalBlocksProcessed} blocks, ${totalTxProcessed} txs | Avg: ${avgBlockSpeed} blocks/s, ${avgTxSpeed} txs/s | ETA: ${hoursRemaining.toFixed(1)}h\n`);

        currentBlock = endBlock + 1;
    }

    console.log('='.repeat(60));
    console.log('Processing complete!');
    console.log(`Total blocks processed: ${totalBlocksProcessed}`);
    console.log(`Total transactions processed: ${totalTxProcessed}`);
    console.log('='.repeat(60));

    await clickhouse.close();
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nReceived SIGINT, shutting down gracefully...');
    await clickhouse.close();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\nReceived SIGTERM, shutting down gracefully...');
    await clickhouse.close();
    process.exit(0);
});

// Handle uncaught errors at process level
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    process.exit(1);
});

main().catch(async (error) => {
    console.error('Fatal error in main():', error);
    await clickhouse.close();
    process.exit(1);
});

