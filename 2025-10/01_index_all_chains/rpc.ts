import { createClient, http, rpcSchema } from "viem";
import type { CallTrace, ArchivedBlock, TraceResult } from "./types.ts";
import { getBlock, getTransactionReceipt } from "viem/actions";
import pLimit from "p-limit";

type DebugRpcSchema = [
    {
        Method: 'debug_traceBlockByNumber';
        Parameters: [string, { tracer: string }];
        ReturnType: TraceResult[];
    }
];

const RpcClientCache = new Map<string, ExtendedRpcClient>();

function getRpcClient(rpcUrl: string): ExtendedRpcClient {
    if (RpcClientCache.has(rpcUrl)) {
        return RpcClientCache.get(rpcUrl)!;
    }

    const viemClient = createRpcClient(rpcUrl);

    RpcClientCache.set(rpcUrl, viemClient);

    return viemClient;
}

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

const RPC_CONCURRENCY = 200; // For regular RPC calls (blocks, receipts)
const DEBUG_CONCURRENCY = 40; // For debug trace calls
const rpcLimit = pLimit(RPC_CONCURRENCY);
const debugLimit = pLimit(DEBUG_CONCURRENCY);

export async function fetchBlockData(rpcUrl: string, blockNumber: number, supportsTraces: boolean): Promise<ArchivedBlock> {
    try {
        const viemClient = getRpcClient(rpcUrl);
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
            supportsTraces ? debugLimit(() => viemClient.traceBlockByNumber(BigInt(blockNumber))) : Promise.resolve(undefined)
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