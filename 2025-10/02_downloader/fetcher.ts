import { createClient, http, rpcSchema } from "viem";
import type { CallTrace, ArchivedBlock, TraceResult } from "./types.ts";
import { getBlock, getBlockNumber, getTransactionReceipt } from "viem/actions";
import pLimit from "p-limit";
import { LocalBlockWriter } from "./readWriter.ts";

type DebugRpcSchema = [
    {
        Method: 'debug_traceBlockByNumber';
        Parameters: [string, { tracer: string }];
        ReturnType: TraceResult[];
    },
    {
        Method: 'debug_traceTransaction';
        Parameters: [string, { tracer: string }];
        ReturnType: TraceResult;
    }
];

type ExtendedRpcClient = ReturnType<typeof createRpcClient>;

// Known transactions that fail to trace with "incorrect number of top-level calls"
const FAILED_TRACE_TXS = new Set([
    '0xc5ad6d3c56b8a5245e0bebca8d8f0d588cab306799d6a901e7480aaa3648aee7',
]);

function createRpcClient(rpcUrl: string) {
    return createClient({
        transport: http(rpcUrl, {
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
        async traceTransaction(txHash: string, tracer: string = 'callTracer') {
            // Return empty trace for known failed transactions
            if (FAILED_TRACE_TXS.has(txHash.toLowerCase())) {
                return {} as TraceResult;
            }
            return client.request({
                method: 'debug_traceTransaction',
                params: [txHash, { tracer }]
            });
        },
    }))
}

export class Fetcher {
    private latestBlock: number = 0;
    private readonly includeTraces: boolean;
    private readonly rpcUrl: string;
    private readonly viemClient: ExtendedRpcClient;
    private readonly rpcLimit: ReturnType<typeof pLimit>;
    private readonly debugLimit: ReturnType<typeof pLimit>;
    private readonly writer: LocalBlockWriter;
    private readonly prefetchWindow: number;
    private readonly blockBuffer: Map<number, ArchivedBlock> = new Map();
    private nextBlockToWrite: number = 1;
    private activeFetches: Set<number> = new Set();

    constructor(options: {
        folder: string;
        rpcUrl: string;
        includeTraces?: boolean;
        rpcConcurrency?: number;
        debugConcurrency?: number;
        sizeCutoffMB?: number;
        prefetchWindow?: number;
    }) {
        this.includeTraces = options.includeTraces ?? false;
        this.rpcUrl = options.rpcUrl;
        this.viemClient = createRpcClient(options.rpcUrl);
        this.rpcLimit = pLimit(options.rpcConcurrency ?? 300);
        this.debugLimit = pLimit(options.debugConcurrency ?? 40);
        this.writer = new LocalBlockWriter(options.folder, options.sizeCutoffMB ?? 128);
        this.prefetchWindow = options.prefetchWindow ?? 500;
    }

    async ready(): Promise<void> {
        await this.writer.ready();
    }

    async start() {
        await this.initialize();

        while (true) {
            // Update latest block if needed
            if (this.nextBlockToWrite > this.latestBlock) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                this.latestBlock = await this.getLatestBlock();
                continue;
            }

            // Start fetches for blocks within the prefetch window
            const windowEnd = Math.min(this.nextBlockToWrite + this.prefetchWindow - 1, this.latestBlock);
            for (let blockNum = this.nextBlockToWrite; blockNum <= windowEnd; blockNum++) {
                if (!this.blockBuffer.has(blockNum) && !this.activeFetches.has(blockNum)) {
                    this.activeFetches.add(blockNum);
                    this.fetchBlockData(blockNum).then(block => {
                        this.blockBuffer.set(blockNum, block);
                        this.activeFetches.delete(blockNum);
                    }).catch(error => {
                        console.error(`Failed to fetch block ${blockNum}:`, error);
                        this.activeFetches.delete(blockNum);
                        // Will retry on next iteration
                    });
                }
            }

            // Wait for the next sequential block to be available
            if (!this.blockBuffer.has(this.nextBlockToWrite)) {
                await new Promise(resolve => setTimeout(resolve, 10));
                continue;
            }

            // Write the next block in order
            const block = this.blockBuffer.get(this.nextBlockToWrite)!;
            this.blockBuffer.delete(this.nextBlockToWrite);
            this.writer.writeBlock(block);

            if (this.nextBlockToWrite % 100 === 0) {
                console.log(`Wrote block ${this.nextBlockToWrite} (buffer size: ${this.blockBuffer.size})`);
            }

            this.nextBlockToWrite++;
        }
    }

    private async initialize() {
        await this.writer.ready();

        const lastWritten = this.writer.getLastWrittenBlock();
        if (lastWritten > 0) {
            this.nextBlockToWrite = lastWritten + 1;
            console.log(`Resuming from block ${this.nextBlockToWrite}`);
        } else {
            this.nextBlockToWrite = 1;
            console.log('Starting from block 1');
        }

        this.latestBlock = await this.getLatestBlock();
        console.log(`Latest block: ${this.latestBlock}, prefetch window: ${this.prefetchWindow}`);
    }

    async close() {
        await this.writer.close();
    }

    private async getLatestBlock(): Promise<number> {
        return Number(await getBlockNumber(this.viemClient));
    }

    private async fetchBlockData(blockNumber: number): Promise<ArchivedBlock> {
        try {
            const block = await this.rpcLimit(() => getBlock(this.viemClient, {
                blockNumber: BigInt(blockNumber),
                includeTransactions: true,
            }));

            if (!block || !block.transactions) {
                throw new Error(`Block ${blockNumber} returned null or has no transactions field`);
            }

            let blockTraces: TraceResult[] | undefined;

            // Get receipts
            const receipts = await Promise.all(
                block.transactions.map(tx =>
                    this.rpcLimit(() => getTransactionReceipt(this.viemClient, { hash: tx.hash }))
                )
            );

            // Get traces if enabled
            if (this.includeTraces) {
                try {
                    // Try to trace the entire block first (more efficient)
                    blockTraces = await this.debugLimit(() =>
                        this.viemClient.traceBlockByNumber(BigInt(blockNumber))
                    );
                } catch (error: any) {
                    // If block tracing fails, fall back to per-transaction tracing
                    console.log(`Block ${blockNumber} trace failed, falling back to per-tx tracing:`, error.message);
                    blockTraces = await Promise.all(
                        block.transactions.map(tx =>
                            this.debugLimit(() => this.viemClient.traceTransaction(tx.hash))
                        )
                    );
                }
            }

            return {
                block,
                traces: blockTraces,
                receipts
            };
        } catch (error: any) {
            console.error(`Error fetching block ${blockNumber}:`, error);
            throw error;
        }
    }
}
