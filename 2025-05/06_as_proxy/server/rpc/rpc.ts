import { createPublicClient, http, type Block, type Chain, type GetBlockReturnType, type PublicClient, type TransactionReceipt } from 'viem';
import type { StoredBlock } from './types.ts';
import { utils } from "@avalabs/avalanchejs";
// Define a type for the JSON-RPC request and response structures
interface JsonRpcRequest {
    jsonrpc: "2.0";
    id: number;
    method: string;
    params: any[];
}

interface JsonRpcResponse {
    jsonrpc: "2.0";
    id: number;
    result?: any;
    error?: {
        code: number;
        message: string;
        data?: any;
    };
}


export class RPC {
    private batchQueue: {
        method: string;
        params: any[];
        resolve: (value: any) => void;
        reject: (error: any) => void;
    }[] = [];
    private intervalId: NodeJS.Timeout | null = null;
    private chainIdCache: number | null = null;
    private isProcessingBatch = false;
    private publicClient: PublicClient;
    private requestsProcessedInInterval: number = 0;
    private lastLogTimestamp: number = Date.now();

    constructor(
        private rpcUrl: string,
        private maxBatchSize: number = 25,
        private batchInterval: number = 50
    ) {
        if (!rpcUrl) {
            throw new Error('RPC_URL is not set');
        }

        // Initialize viem public client
        this.publicClient = createPublicClient({
            transport: http(rpcUrl)
        });

        // Start the interval for regular batch processing
        this.intervalId = setInterval(() => this.processBatch(), this.batchInterval);
    }

    public async loadChainId(): Promise<void> {
        if (this.chainIdCache === null) {
            this.chainIdCache = await this.getChainId();
        }
    }

    public getCachedChainId(): number | null {
        return this.chainIdCache;
    }

    private request<T>(method: string, params: any[] = []): Promise<T> {
        return new Promise((resolve, reject) => {
            this.batchQueue.push({ method, params, resolve, reject });
        });
    }

    private async processBatch() {
        // Don't run concurrent batch processing
        if (this.isProcessingBatch || this.batchQueue.length === 0) return;

        this.isProcessingBatch = true;

        try {
            // Take at most maxBatchSize items from the queue, maintaining FIFO order
            const batchToProcess = this.batchQueue.splice(0, this.maxBatchSize);
            this.requestsProcessedInInterval += batchToProcess.length;

            const batchRequests: JsonRpcRequest[] = batchToProcess.map(({ method, params }, index) => ({
                jsonrpc: "2.0",
                id: index,
                method,
                params
            }));

            try {
                // Perform the fetch directly - we're already timing batches
                const fetchStartTime = Date.now();
                const httpResponse = await fetch(this.rpcUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(batchRequests)
                });
                const fetchEndTime = Date.now();
                // console.log(`[RPC Fetch Stats] Batch of ${batchRequests.length} requests took ${fetchEndTime - fetchStartTime}ms to ${this.rpcUrl}`);

                if (!httpResponse.ok) {
                    const errorText = await httpResponse.text();
                    throw new Error(`RPC request failed with status ${httpResponse.status}: ${errorText}`);
                }

                const responses = await httpResponse.json() as JsonRpcResponse[];

                if (!Array.isArray(responses)) {
                    throw new Error('Batch RPC response is not an array');
                }

                responses.forEach((response) => {
                    const requestItem = batchToProcess[response.id];
                    if (requestItem) {
                        if (response.error) {
                            requestItem.reject(response.error);
                        } else {
                            requestItem.resolve(response.result);
                        }
                    } else {
                        console.error(`Received response for unknown ID: ${response.id}`);
                    }
                });
            } catch (error) {
                batchToProcess.forEach(item => item.reject(error));
            }
        } finally {
            this.isProcessingBatch = false;

            const currentTime = Date.now();
            if (currentTime - this.lastLogTimestamp >= 1000) {
                const intervalSeconds = (currentTime - this.lastLogTimestamp) / 1000;
                console.log(`[RPC Stats @ ${new Date(currentTime).toISOString()}] Queue: ${this.batchQueue.length}, Processed in last ${intervalSeconds.toFixed(3)}s: ${this.requestsProcessedInInterval}, Interval: ${intervalSeconds.toFixed(3)}s`);
                this.requestsProcessedInInterval = 0;
                this.lastLogTimestamp = currentTime;
            }
        }
    }

    // Cleanup method to cancel the interval when done
    public dispose() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    public async fetchBlockAndReceipts(blockNumber: number): Promise<StoredBlock> {
        const block = await this.getBlock(BigInt(blockNumber), true);

        const receiptPromises = block.transactions.map(tx => {
            const txHash = typeof tx === 'string' ? tx : (tx as { hash: `0x${string}` }).hash;
            return this.getTransactionReceipt(txHash as `0x${string}`)
                .then(receipt => [txHash, receipt] as const);
        });

        const receiptEntries = await Promise.all(receiptPromises);
        const receipts = Object.fromEntries(receiptEntries) as Record<string, TransactionReceipt>;


        if (Object.keys(receipts).length !== block.transactions.length) {
            console.log('block: ', block);
            console.log('receipts: ', receipts);
            throw new Error('Receipts length mismatch, block: ' + blockNumber);
        }

        return { block: block as GetBlockReturnType<Chain, true, 'latest'>, receipts };
    }

    public getCurrentBlockNumber(): Promise<number> {
        return this.request<string>('eth_blockNumber').then(hex => parseInt(hex, 16));
    }

    public getChainId(): Promise<number> {
        return this.request<string>('eth_chainId').then(hex => parseInt(hex, 16));
    }

    public getBlock(blockNumberOrTag: bigint | 'latest' | 'earliest' | 'pending', includeTransactions: boolean = true): Promise<Block<bigint, typeof includeTransactions>> {
        const paramBlock = typeof blockNumberOrTag === 'bigint' ? `0x${blockNumberOrTag.toString(16)}` : blockNumberOrTag;
        return this.request<Block<bigint, typeof includeTransactions>>('eth_getBlockByNumber', [paramBlock, includeTransactions]);
    }

    public getTransactionReceipt(txHash: `0x${string}`): Promise<TransactionReceipt> {
        return this.request<TransactionReceipt>('eth_getTransactionReceipt', [txHash]);
    }

    public async getBlockchainIDFromPrecompile(): Promise<string> {
        const WARP_PRECOMPILE_ADDRESS = '0x0200000000000000000000000000000000000005' as const;

        // Create a call data for the precompile contract
        const callData = {
            to: WARP_PRECOMPILE_ADDRESS,
            data: '0x4213cf78' // Function signature for getBlockchainID()
        };

        // Use eth_call to execute the view function
        const blockchainIDHex = await this.request<string>('eth_call', [callData, 'latest']);

        const chainIdBytes = utils.hexToBuffer(blockchainIDHex);
        const avalancheChainId = utils.base58check.encode(chainIdBytes);

        return avalancheChainId;
    }
}

import pLimit from 'p-limit';
import pThrottle from 'p-throttle';

const concurencyLimiter = pLimit(10);
const requestThrottle = pThrottle({
    limit: 10,
    interval: 1000
});

//simple rewrite of the rpc above
export class BatchRpc {
    constructor(
        private rpcUrl: string,
        private maxBatchSize: number = 25
    ) {
        if (!rpcUrl) {
            throw new Error('RPC_URL is not set or empty');
        }
        if (this.maxBatchSize <= 0) {
            throw new Error('maxBatchSize must be positive');
        }
    }

    /**
     * Sends a single pre-formed batch of JSON-RPC operations.
     * This is a private helper, and its execution (the fetch call) is wrapped by throttle and limiters by the caller.
     * Operations within this batch share a single HTTP request.
     * @param operations Array of operations for THIS batch, with internalId for correlation.
     */
    private async sendSingleJsonRpcBatch<T = any>(
        operations: Array<{ method: string; params: any[]; internalId: number | string }>
    ): Promise<Array<{ internalId: number | string; result?: T; error?: any }>> {
        const jsonRpcRequests: JsonRpcRequest[] = operations.map(({ method, params }, index) => ({
            jsonrpc: "2.0",
            id: index, // Batch-local ID, 0 to N-1 for this batch
            method,
            params
        }));

        const executeFetch = async () => {
            const httpResponse = await fetch(this.rpcUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(jsonRpcRequests)
            });

            if (!httpResponse.ok) {
                const errorText = await httpResponse.text().catch(() => "Failed to get error text");
                throw new Error(`RPC batch request failed to ${this.rpcUrl} with status ${httpResponse.status}: ${errorText}`);
            }
            // Server might return single response for single-item batch, or if batch request itself is an error.
            const jsonData = await httpResponse.json();
            return jsonData as unknown as JsonRpcResponse[] | JsonRpcResponse;
        };

        try {
            // Apply throttle and concurrency limit to the actual fetch execution
            const responses = await requestThrottle(() => concurencyLimiter(executeFetch))();

            let individualResponses: JsonRpcResponse[];
            if (Array.isArray(responses)) {
                individualResponses = responses;
            } else if (responses && typeof responses === 'object' && 'jsonrpc' in responses) {
                // Handle cases where server returns a single response object (e.g. for a single item batch, or a batch-level error response)
                individualResponses = [responses as JsonRpcResponse];
            } else {
                throw new Error('Batch RPC response from server is not a valid JSON-RPC response or array of responses.');
            }

            const resultsMap = new Map<number, JsonRpcResponse>();
            individualResponses.forEach(response => {
                // Ensure ID is a number for map key / array index consistency.
                // JSON-RPC spec says ID can be string, number, or null.
                // Our batch-local IDs are always numbers (array indices).
                if (typeof response.id === 'number') {
                    resultsMap.set(response.id, response);
                } else {
                    // This might happen if the server returns an error for the batch itself without an ID, or with a non-numeric ID.
                    // If the batch had one item and its ID was non-numeric, this also needs care.
                    // For robustly mapping, if only one response and one op, can assume they match.
                    if (operations.length === 1 && individualResponses.length === 1) {
                        // Assume this single response corresponds to the single operation's batch-local id (0)
                        resultsMap.set(0, response);
                    } else {
                        console.error('RPC response item received with non-numeric or missing ID, cannot reliably map:', response);
                    }
                }
            });

            const results = operations.map((op, index) => { // index is the batch-local index (0..N-1)
                const responseForOp = resultsMap.get(index);
                if (responseForOp) {
                    return {
                        internalId: op.internalId, // This is the original overall ID (e.g. original_index)
                        result: responseForOp.result as T,
                        error: responseForOp.error
                    };
                }
                return {
                    internalId: op.internalId,
                    error: new Error(`No response for operation (method: ${op.method}, params: ${JSON.stringify(op.params)}) in batch. Batch-local index: ${index}.`)
                };
            });

            // console.log('Done a request with', results.length, 'results')
            return results

        } catch (batchLevelError) {
            return operations.map(op => ({
                internalId: op.internalId,
                error: batchLevelError
            }));
        }
    }

    /**
     * Takes a list of logical RPC requests, splits them into batches according to `maxBatchSize`,
     * executes these batches in parallel (respecting concurrency/throttle limits via `sendSingleJsonRpcBatch`),
     * and returns the aggregated results in the original order.
     * This replaces the original `batchRequest` stub and its TODO.
     */
    public async batchRpcRequests<T = any>(
        requests: Array<{ method: string; params: any[]; idToCorrelate?: any }>
    ): Promise<Array<{ idToCorrelate?: any; result?: T; error?: any }>> {
        if (!requests || requests.length === 0) {
            return [];
        }

        const indexedRequests = requests.map((req, index) => ({
            method: req.method,
            params: req.params,
            idToCorrelate: req.idToCorrelate,
            internalSequentialId: index // Original index for re-ordering
        }));

        const operationChunks: Array<Array<typeof indexedRequests[0]>> = [];
        for (let i = 0; i < indexedRequests.length; i += this.maxBatchSize) {
            operationChunks.push(indexedRequests.slice(i, i + this.maxBatchSize));
        }

        const batchExecutionPromises = operationChunks.map(chunk =>
            this.sendSingleJsonRpcBatch<T>(
                chunk.map(opInChunk => ({ // Map to structure expected by sendSingleJsonRpcBatch
                    method: opInChunk.method,
                    params: opInChunk.params,
                    internalId: opInChunk.internalSequentialId // Pass original index as internalId
                }))
            )
        );

        const resultsFromAllHttpBatches = await Promise.all(batchExecutionPromises);

        const finalResults = new Array(requests.length);
        resultsFromAllHttpBatches.forEach(batchResultArray => {
            batchResultArray.forEach(singleOpResult => {
                const originalRequestIndex = singleOpResult.internalId as number;
                if (originalRequestIndex !== undefined && originalRequestIndex < requests.length) {
                    finalResults[originalRequestIndex] = {
                        idToCorrelate: requests[originalRequestIndex].idToCorrelate,
                        result: singleOpResult.result,
                        error: singleOpResult.error
                    };
                } else {
                    console.error("Error mapping result back: internalId missing or out of bounds", singleOpResult);
                }
            });
        });

        // Check for any errors in the results and throw if found
        for (const result of finalResults) {
            if (result && result.error) {
                // Throw the first error encountered
                // It might be useful to aggregate errors or provide more context,
                // but for now, throwing the first error directly.
                throw result.error;
            }
        }
        return finalResults;
    }

    /**
     * Fetches multiple blocks and their transaction receipts using batched RPC calls.
     * Implements the `getBlocksWithReceipts` TODO.
     */
    public async getBlocksWithReceipts(blockNumbers: number[]): Promise<StoredBlock[]> {
        if (!blockNumbers || blockNumbers.length === 0) {
            return [];
        }

        // Stage 1: Fetch all blocks
        const blockOperations = blockNumbers.map((num, index) => ({
            method: 'eth_getBlockByNumber',
            params: [`0x${num.toString(16)}`, true], // true for includeTransactions
            idToCorrelate: { type: 'block_fetch', blockNumber: num, originalBlockIndex: index }
        }));

        const blockResponses = await this.batchRpcRequests<GetBlockReturnType<Chain, true, 'latest'>>(blockOperations);

        const successfullyFetchedBlocksMap = new Map<number, GetBlockReturnType<Chain, true, 'latest'>>();
        const receiptOperations: Array<{ method: string; params: [`0x${string}`]; idToCorrelate: { type: 'receipt_fetch', originalBlockIndex: number; txHash: `0x${string}` } }> = [];

        blockResponses.forEach(response => {
            const correlationData = response.idToCorrelate as { type: 'block_fetch', blockNumber: number, originalBlockIndex: number };
            if (response.error || !response.result) {
                console.warn(`Failed to fetch block ${correlationData.blockNumber} (original index ${correlationData.originalBlockIndex}):`, response.error || 'No result');
                return;
            }

            const block = response.result;
            successfullyFetchedBlocksMap.set(correlationData.originalBlockIndex, block);

            if (block.transactions && Array.isArray(block.transactions)) {
                block.transactions.forEach(tx => {
                    let txHash: `0x${string}` | undefined;
                    if (typeof tx === 'string') {
                        txHash = tx;
                    } else if (tx && typeof tx === 'object' && tx.hash && typeof tx.hash === 'string') {
                        txHash = tx.hash as `0x${string}`;
                    }

                    if (txHash) {
                        receiptOperations.push({
                            method: 'eth_getTransactionReceipt',
                            params: [txHash],
                            idToCorrelate: {
                                type: 'receipt_fetch',
                                originalBlockIndex: correlationData.originalBlockIndex,
                                txHash
                            }
                        });
                    } else {
                        console.warn(`Transaction in block ${correlationData.blockNumber} (original index ${correlationData.originalBlockIndex}) has an unexpected format or no hash:`, tx);
                    }
                });
            }
        });

        // Stage 2: Fetch receipts for transactions from successfully fetched blocks
        const receiptResponses = receiptOperations.length > 0
            ? await this.batchRpcRequests<TransactionReceipt>(receiptOperations)
            : [];

        // Stage 3: Assemble StoredBlock results, ensuring order and handling missing blocks
        const storedBlocksResult: StoredBlock[] = [];
        for (let i = 0; i < blockNumbers.length; i++) {
            const blockData = successfullyFetchedBlocksMap.get(i);
            if (blockData) { // Only proceed if this block was successfully fetched
                const currentStoredBlock: StoredBlock = {
                    block: blockData,
                    receipts: {}
                };
                // Populate receipts for this block
                receiptResponses.forEach(receiptResponse => {
                    const receiptCorrelation = receiptResponse.idToCorrelate as { type: 'receipt_fetch', originalBlockIndex: number; txHash: `0x${string}` };
                    if (receiptCorrelation.originalBlockIndex === i) { // Match receipts to the current block being assembled
                        if (receiptResponse.result && !receiptResponse.error) {
                            currentStoredBlock.receipts[receiptCorrelation.txHash] = receiptResponse.result;
                        } else {
                            console.warn(`Failed to fetch receipt for tx ${receiptCorrelation.txHash} in block (original index ${i}):`, receiptResponse.error || 'No result');
                        }
                    }
                });
                storedBlocksResult.push(currentStoredBlock);
            }
            // If blockData for index 'i' is undefined, that block fetch failed and it's omitted from the final results.
            // This means the output array may be shorter than blockNumbers if some blocks couldn't be fetched.
        }
        return storedBlocksResult;
    }
}
