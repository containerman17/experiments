import type { BlockCache, StoredBlock } from "./types.ts";
import { RPC } from "./rpc.ts";

export class CachedRPC {
    constructor(private cache: BlockCache, private rpc: RPC) {
    }

    async getBlock(blockNumber: number): Promise<StoredBlock> {
        let block: StoredBlock | null = await this.cache.loadBlock(blockNumber);
        if (block) {
            return block;
        }
        block = await this.rpc.fetchBlockAndReceipts(blockNumber);
        await this.cache.saveBlock(blockNumber, block);
        return block;
    }
}
