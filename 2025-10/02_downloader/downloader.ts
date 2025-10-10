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
    }
];

type ExtendedRpcClient = ReturnType<typeof createRpcClient>;

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
    }))
}

export class Fetcher {
    private lastFetchedBlock: number = -1;
    private latestBlock: number = 0;
    private readonly includeTraces: boolean;
    private readonly rpcUrl: string;
    private readonly viemClient: ExtendedRpcClient;
    private readonly rpcLimit: ReturnType<typeof pLimit>;
    private readonly debugLimit: ReturnType<typeof pLimit>;
    private readonly writer: LocalBlockWriter;

    constructor(options: {
        folder: string;
        rpcUrl: string;
        includeTraces?: boolean;
        rpcConcurrency?: number;
        debugConcurrency?: number;
        sizeCutoffMB?: number;
    }) {
        this.includeTraces = options.includeTraces ?? false;
        this.rpcUrl = options.rpcUrl;
        this.viemClient = createRpcClient(options.rpcUrl);
        this.rpcLimit = pLimit(options.rpcConcurrency ?? 200);
        this.debugLimit = pLimit(options.debugConcurrency ?? 40);
        this.writer = new LocalBlockWriter(options.folder, options.sizeCutoffMB ?? 128);
    }

    async ready(): Promise<void> {
        await this.writer.ready();
    }

    async start() {
        // Resume from last written block
        await this.initialize();

        while (true) {
            if (this.lastFetchedBlock >= this.latestBlock) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                this.latestBlock = await this.getLatestBlock();
            }

            const nextBlock = this.lastFetchedBlock + 1;
            const block = await this.fetchBlockData(nextBlock);

            // Write block
            this.writer.writeBlock(block);
            this.lastFetchedBlock = Number(block.block.number);
            if (this.lastFetchedBlock % 100 === 0) {
                console.log(`Fetched block ${this.lastFetchedBlock}`);
            }
        }
    }

    private async initialize() {
        // Wait for writer to be ready
        await this.writer.ready();

        const lastWritten = this.writer.getLastWrittenBlock();
        if (lastWritten > 0) {
            this.lastFetchedBlock = lastWritten;
            console.log(`Resuming from block ${this.lastFetchedBlock}`);
        } else {
            this.lastFetchedBlock = 0;
            console.log('Starting from block 1');
        }

        this.latestBlock = await this.getLatestBlock();
        console.log(`Latest block: ${this.latestBlock}`);
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

            const [receipts, blockTraces] = await Promise.all([
                Promise.all(
                    block.transactions.map(tx =>
                        this.rpcLimit(() => getTransactionReceipt(this.viemClient, { hash: tx.hash }))
                    )
                ),
                this.includeTraces ?
                    this.debugLimit(() => this.viemClient.traceBlockByNumber(BigInt(blockNumber))) :
                    Promise.resolve(undefined)
            ]);

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
