import { GetBlockReturnType, Chain } from "viem";

export type StoredBlock = {
    block: GetBlockReturnType<Chain, true, 'latest'>;
    receipts: Record<string, any>;
}

export interface BlockCacheStore {
    storeBlock(blockNumber: number, block: StoredBlock): Promise<void>;
    getBlock(blockNumber: number): Promise<StoredBlock | null>;
}
