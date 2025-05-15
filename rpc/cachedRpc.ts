import { RPC } from "./rpc";
import { BlockCacheStore, StoredBlock } from "./types";

export class CachedRPC {
    constructor(private store: BlockCacheStore, private rpc: RPC) {
    }

    async fetchBlockAndReceipts(blockNumber: number): Promise<StoredBlock> {
        console.time('fetchBlockAndReceipts(' + blockNumber + ')');
        try {
            const cachedBlock = await this.store.getBlock(blockNumber);
            if (cachedBlock) {
                console.log('cached block ' + blockNumber);
                return cachedBlock;
            }
            console.log('uncached block ' + blockNumber);
            const block = await this.rpc.fetchBlockAndReceipts(blockNumber);
            await this.store.storeBlock(blockNumber, block);
            return block;
        } finally {
            console.timeEnd('fetchBlockAndReceipts(' + blockNumber + ')');
        }
    }
}
