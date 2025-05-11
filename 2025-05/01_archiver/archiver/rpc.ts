import { createPublicClient, http, webSocket } from 'viem';
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
            this.chainId = await this.client.getChainId();
        }
    }

    public async fetchBlockAndReceipts(blockNumber: number): Promise<{
        block: any;
        receipts: Record<string, any>;
    }> {
        const getBlock = this.throttle(async (bn: bigint) => {
            return await this.client.getBlock({
                blockNumber: bn,
                includeTransactions: true,
            });
        });

        const getReceipt = this.throttle(async (txHash: string) => {
            return await this.client.getTransactionReceipt({
                hash: txHash as `0x${string}`,
            });
        });

        const block = await getBlock(BigInt(blockNumber));

        const receiptPromises = block.transactions.map(tx =>
            getReceipt(tx.hash).then(receipt => [tx.hash, receipt])
        );

        const receiptEntries = await Promise.all(receiptPromises);
        const receipts = Object.fromEntries(receiptEntries);

        return { block, receipts };
    }

    public async getCurrentBlockNumber(): Promise<bigint> {
        const getBlockNumber = this.throttle(async () => {
            return await this.client.getBlockNumber();
        });

        return await getBlockNumber();
    }

    public async getChainId(): Promise<number> {
        const getChainId = this.throttle(async () => {
            return await this.client.getChainId();
        });

        return await getChainId();
    }
}
