import pThrottle from 'p-throttle';
import { createPublicClient, http, PublicClient } from 'viem';

export const throttle = pThrottle({
    limit: 10,
    interval: 1000,
});

const rpcUrl = process.env.RPC_URL;
if (!rpcUrl) {
    throw new Error('RPC_URL environment variable is not set');
}

const client = createPublicClient({
    transport: http(rpcUrl),
});

export const throttledGetBlock = throttle(async (blockNumber: bigint) => {
    return client.getBlock({ blockNumber, includeTransactions: true });
});

export const throttledGetTransactionReceipt = throttle(async (txHash: string) => {
    return client.getTransactionReceipt({ hash: txHash as `0x${string}` });
});

export const throttledGetBlockNumber = throttle(async () => {
    return client.getBlockNumber();
}); 
