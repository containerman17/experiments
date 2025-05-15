export interface RPCCacher {
    getBlock(blockNumber: number): Promise<Block>;
}
