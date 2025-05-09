import { createPublicClient, http, webSocket } from 'viem';
import { mainnet } from 'viem/chains';

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
    throw new Error('RPC_URL is not set');
}

const transport = RPC_URL.startsWith('ws') ? webSocket(RPC_URL) : http(RPC_URL);
const client = createPublicClient({
    chain: mainnet,
    transport,
});

export async function fetchBlockAndReceipts(blockNumber: bigint): Promise<{
    block: any;
    receipts: Record<string, any>;
}> {
    const block = await client.getBlock({
        blockNumber,
        includeTransactions: true,
    });

    const receipts: Record<string, any> = {};
    for (const tx of block.transactions) {
        const receipt = await client.getTransactionReceipt({
            hash: tx.hash,
        });
        receipts[tx.hash] = receipt;
    }

    return { block, receipts };
}

export async function getCurrentBlockNumber(): Promise<bigint> {
    return await client.getBlockNumber();
}
