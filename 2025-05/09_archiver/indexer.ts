import { BatchRpc, fetchBlockchainIDFromPrecompile } from "./rpc/rpc.ts"
import type { StoredBlock } from "./rpc/types.ts";
import dotenv from 'dotenv';
import { initializeDatabase, Database } from "./database/db.ts";
import { mkdir } from 'node:fs/promises';
import { SqliteBlockStore } from "./rpc/sqliteCache.ts";
import { startAPI } from "./api.ts";

dotenv.config();

const interval_seconds = 5; // Default polling interval

//This function is guaranteed to be called in order and inside a transaction
function handleBlock(db: Database, chainId: string, { block, receipts }: StoredBlock) {
    if (Number(block.number) % 100 === 0) {
        console.log(`[${chainId}] handleBlock`, Number(block.number), `with ${Object.keys(receipts).length} receipts`)
    }
    for (const tx of block.transactions) {
        db.insertTxBlockLookup(tx.hash, Number(block.number))
    }
    db.updateConfig('last_processed_block', Number(block.number).toString())
    db.recordTxCount(Object.keys(receipts).length, Number(block.timestamp))
}

export class Indexer {
    public rpc: BatchRpc;
    public db: Database;
    private blockchainID: string;
    private isLocal: boolean;
    private PROCESSING_BATCH_SIZE: number;

    constructor(rpcUrl: string, blockchainID: string) {
        this.blockchainID = blockchainID;
        this.isLocal = rpcUrl.includes('localhost') || rpcUrl.includes('127.0.0.1');
        this.PROCESSING_BATCH_SIZE = this.isLocal ? 10000 : 1000;

        const rawDb = initializeDatabase(blockchainID);
        this.db = new Database(rawDb);

        const cacher = new SqliteBlockStore(`./data/${blockchainID}/blocks.sqlite`);
        const concurrency = this.isLocal ? 100 : 10;

        this.rpc = new BatchRpc({
            rpcUrl,
            cache: cacher,
            maxBatchSize: this.isLocal ? 100 : 100,
            maxConcurrency: concurrency,
            rps: concurrency * (this.isLocal ? 10 : 2)
        });
    }

    async startLoop() {
        console.log(`Starting indexer loop for blockchain ${this.blockchainID}...`);

        while (true) {
            const start = performance.now();

            const latestBlock = await this.rpc.getCurrentBlockNumber();

            const lastProcessedBlock = this.db.getConfig('last_processed_block');
            let currentBlockToProcess = parseInt(lastProcessedBlock || '-1') + 1;

            console.log(`[${this.blockchainID}] Loop iteration. Current block to process: ${currentBlockToProcess}, Latest block from RPC: ${latestBlock}`);

            if (currentBlockToProcess > latestBlock) {
                await new Promise(resolve => setTimeout(resolve, interval_seconds * 1000));
                continue;
            }

            const blockNumbersToFetch: number[] = [];
            const endRange = Math.min(latestBlock, currentBlockToProcess + this.PROCESSING_BATCH_SIZE - 1);

            for (let i = currentBlockToProcess; i <= endRange; i++) {
                blockNumbersToFetch.push(i);
            }

            if (blockNumbersToFetch.length === 0) {
                console.log(`[${this.blockchainID}] No new blocks to fetch in this range. Waiting...`);
                await new Promise(resolve => setTimeout(resolve, interval_seconds * 1000));
                continue;
            }

            console.log(`[${this.blockchainID}] Attempting to fetch ${blockNumbersToFetch.length} blocks: from ${blockNumbersToFetch[0]} to ${blockNumbersToFetch[blockNumbersToFetch.length - 1]}`);

            try {
                const fetchedBlocks = await this.rpc.getBlocksWithReceipts(blockNumbersToFetch);

                if (fetchedBlocks.length > 0) {
                    console.log(`[${this.blockchainID}] Received ${fetchedBlocks.length} blocks. Processing them in a transaction.`);

                    const txStart = performance.now();
                    this.db.transaction(() => {
                        for (const block of fetchedBlocks) {
                            handleBlock(this.db, this.blockchainID, block);
                        }
                    });
                    console.log(`[${this.blockchainID}] Time taken to process ${fetchedBlocks.length} blocks: ${performance.now() - txStart}ms`);
                    console.log(`[${this.blockchainID}] Successfully processed batch. Last block in DB should now be updated by handleBlock.`);
                } else if (blockNumbersToFetch.length > 0) {
                    console.warn(`[${this.blockchainID}] Requested ${blockNumbersToFetch.length} blocks, but received 0. Possible gap or RPC issue. Waiting before retry.`);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }

            } catch (error) {
                console.error(`[${this.blockchainID}] Error during block fetching or processing batch starting from ${blockNumbersToFetch[0]}:`, error);
                console.log(`[${this.blockchainID}] Waiting before retrying...`);
                await new Promise(resolve => setTimeout(resolve, interval_seconds * 1000));
            }

            const end = performance.now();
            console.log(`[${this.blockchainID}] Time taken: ${end - start}ms`);
        }
    }
}

async function main() {
    const rpcUrls = process.env.RPC_URLS;
    if (!rpcUrls) {
        console.error("RPC_URLS environment variable is not set.");
        process.exit(1);
    }

    const urls = rpcUrls.split(',').map(url => url.trim());
    const indexers = new Map<string, Indexer>();
    const aliases = new Map<string, string>(); // Maps alias -> primary blockchain ID

    // Initialize all indexers
    for (const rpcUrl of urls) {
        const blockchainID = await fetchBlockchainIDFromPrecompile(rpcUrl);
        await mkdir(`./data/${blockchainID}`, { recursive: true });

        const indexer = new Indexer(rpcUrl, blockchainID);

        const evmChainId = await indexer.rpc.getEvmChainId()
        console.log(`[${blockchainID}] EVM Chain ID: ${evmChainId}`)

        // Store indexer with primary blockchain ID
        indexers.set(blockchainID, indexer);

        // Add aliases for EVM chain ID
        aliases.set(evmChainId.toString(), blockchainID); // decimal
        aliases.set("0x" + evmChainId.toString(16), blockchainID); // hex

        // Start the indexer loop (non-blocking)
        indexer.startLoop().catch(error => {
            console.error(`Critical error in indexer for ${blockchainID}:`, error);
            process.exit(1);
        });
    }

    if (indexers.size === 0) {
        console.error("No valid RPC URLs provided");
        process.exit(1);
    }

    startAPI(indexers, aliases).catch(error => {
        console.error("Critical error in startAPI:", error);
        process.exit(1);
    });
}

main().catch(error => {
    console.error("Critical error in main:", error);
    process.exit(1);
});
