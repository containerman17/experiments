import { createPublicClient, http, webSocket, type Block, type PublicClient, type TransactionReceipt } from 'viem';
import { mainnet } from 'viem/chains';
import pThrottle from 'p-throttle';

export class RPC {
    private client;
    private throttle;
    private chainId: number = 0;

    constructor(private rpcUrl: string, private rps: number = 50) {
        if (!rpcUrl) {
            throw new Error('RPC_URL is not set');
        }

        const DIVIDER = 10;
        this.throttle = pThrottle({
            limit: this.rps / DIVIDER,
            interval: 1000 / DIVIDER,
        });

        const transport = rpcUrl.startsWith('ws') ? webSocket(rpcUrl) : http(rpcUrl);
        this.client = createPublicClient({
            chain: mainnet,
            transport,
        });
    }

    public async loadChainId(): Promise<void> {
        if (this.chainId === 0) {
            this.chainId = await getChainId(this.client);
        }
    }

    public async fetchBlockAndReceipts(blockNumber: number): Promise<{
        block: any;
        receipts: Record<string, any>;
    }> {
        const getBlockThrottled = this.throttle(async (bn: bigint) => {
            return await getBlock(this.client, bn);
        });

        const getReceiptThrottled = this.throttle(async (txHash: string) => {
            return await getTransactionReceipt(this.client, txHash as `0x${string}`);
        });

        const block = await getBlockThrottled(BigInt(blockNumber));

        const receiptPromises = block.transactions.map(tx =>
            getReceiptThrottled(tx.hash).then(receipt => [tx.hash, receipt])
        );

        const receiptEntries = await Promise.all(receiptPromises);
        const receipts = Object.fromEntries(receiptEntries);

        return { block, receipts };
    }

    public async getCurrentBlockNumber(): Promise<bigint> {
        const getBlockNumberThrottled = this.throttle(async () => {
            return await getBlockNumber(this.client);
        });

        return await getBlockNumberThrottled();
    }

    public async getChainId(): Promise<number> {
        const getChainIdThrottled = this.throttle(async () => {
            return await getChainId(this.client);
        });

        return await getChainIdThrottled();
    }
}


function getBlockNumber(client: PublicClient): Promise<bigint> {
    return client.request({
        method: 'eth_blockNumber',
    });
}

function getTransactionReceipt(client: PublicClient, txHash: `0x${string}`): Promise<TransactionReceipt> {
    return client.request({
        method: 'eth_getTransactionReceipt',
        params: [txHash],
    });
}

function getBlock(client: PublicClient, blockNumber: bigint): Promise<Block<bigint, true>> {
    return client.request({
        method: 'eth_getBlockByNumber',
        params: [`0x${blockNumber.toString(16)}`, true],
    });
}

function getChainId(client: PublicClient): Promise<number> {
    return client.request({
        method: 'eth_chainId',
    });
}
