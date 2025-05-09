import { createPublicClient, http, webSocket } from 'viem';
import { mainnet } from 'viem/chains';
import pThrottle from 'p-throttle';

const throttle = pThrottle({
    limit: 10,
    interval: 1000,
});

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
    throw new Error('RPC_URL is not set');
}

const transport = RPC_URL.startsWith('ws') ? webSocket(RPC_URL) : http(RPC_URL);
const client = createPublicClient({
    chain: mainnet,
    transport,
});

const throttledGetBlock = throttle(async (blockNumber: bigint) => {
    return await client.getBlock({
        blockNumber,
        includeTransactions: true,
    });
});

const throttledGetTransactionReceipt = throttle(async (txHash: string) => {
    return await client.getTransactionReceipt({
        hash: txHash as `0x${string}`,
    });
});

const throttledGetBlockNumber = throttle(async () => {
    return await client.getBlockNumber();
});

export async function fetchBlockAndReceipts(blockNumber: bigint): Promise<{
    block: any;
    receipts: Record<string, any>;
}> {
    const block = await throttledGetBlock(blockNumber);

    const receipts: Record<string, any> = {};
    for (const tx of block.transactions) {
        const receipt = await throttledGetTransactionReceipt(tx.hash);
        receipts[tx.hash] = receipt;
    }

    return { block, receipts };
}

export async function getCurrentBlockNumber(): Promise<bigint> {
    return await throttledGetBlockNumber();
}
