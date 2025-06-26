import { BatchRpc } from "./BatchRpc";
import { BlockDB } from "./BlockDB";

const NO_BLOCKS_PAUSE_TIME = 3 * 1000;
const ERROR_PAUSE_TIME = 10 * 1000;

export async function startFetchingLoop(blockDB: BlockDB, batchRpc: BatchRpc, blocksPerBatch: number) {
    let latestRemoteBlock = blockDB.getBlockchainLatestBlockNum()
    //lazy load latest block from the chain
    if (latestRemoteBlock === -1) {
        const newLatestRemoteBlock = await batchRpc.getCurrentBlockNumber();
        blockDB.setBlockchainLatestBlockNum(newLatestRemoteBlock);
        latestRemoteBlock = newLatestRemoteBlock;
    }

    let lastStoredBlock = blockDB.getLastStoredBlockNumber();

    while (true) {
        // Check if we've caught up to the latest remote block
        if (lastStoredBlock >= latestRemoteBlock) {
            const newLatestRemoteBlock = await batchRpc.getCurrentBlockNumber();
            if (newLatestRemoteBlock === latestRemoteBlock) {
                console.log(`No new blocks, pause before checking again ${NO_BLOCKS_PAUSE_TIME / 1000}s`);
                await new Promise(resolve => setTimeout(resolve, NO_BLOCKS_PAUSE_TIME));
                continue;
            }
            // Update latest remote block and continue fetching
            latestRemoteBlock = newLatestRemoteBlock;
            console.log(`Updated latest remote block to ${latestRemoteBlock}`);
            blockDB.setBlockchainLatestBlockNum(latestRemoteBlock);
        }

        const startBlock = lastStoredBlock + 1;
        const endBlock = Math.min(startBlock + blocksPerBatch - 1, latestRemoteBlock);
        try {
            const blocks = await batchRpc.getBlocksWithReceipts([startBlock, endBlock]);
            blockDB.storeBlocks(blocks);
            lastStoredBlock = endBlock;
        } catch (error) {
            console.error(error);
            await new Promise(resolve => setTimeout(resolve, ERROR_PAUSE_TIME));
        }
    }
}   
