import { BatchRpc } from "./rpc/rpc.ts"
import type { Hex, Transaction, TransactionReceipt } from 'viem';
import { Database } from "./database/db.ts";

export class IndexerAPI {
    public db: Database;
    private rpc: BatchRpc;

    constructor(database: Database, rpc: BatchRpc) {
        this.db = database;
        this.rpc = rpc;
    }

    async getTx(txHash: Hex): Promise<{ transaction: Transaction; receipt: TransactionReceipt; blockNumber: bigint } | null> {
        const potentialBlockNumbers = this.db.getTxLookupByPrefix(txHash);

        if (potentialBlockNumbers.length === 0) {
            return null;
        }

        // Sort to fetch in order, though not strictly necessary for correctness here
        potentialBlockNumbers.sort((a, b) => a - b);

        const fetchedBlocksData = await this.rpc.getBlocksWithReceipts(potentialBlockNumbers);

        for (const storedBlock of fetchedBlocksData) {
            if (storedBlock && storedBlock.block && storedBlock.block.transactions && storedBlock.receipts) {
                for (let i = 0; i < storedBlock.block.transactions.length; i++) {
                    const tx = storedBlock.block.transactions[i];
                    if (tx && tx.hash === txHash) {
                        const receipt = storedBlock.receipts[txHash];
                        if (receipt) {
                            return {
                                transaction: tx as Transaction,
                                receipt: receipt,
                                blockNumber: storedBlock.block.number
                            };
                        }
                    }
                }
            }
        }
        return null;
    }
}
