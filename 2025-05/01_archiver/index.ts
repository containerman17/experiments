import { fetchBlockAndReceipts, getCurrentBlockNumber } from "./rpc";
import fs from "fs";
let lastBlockOnChain = await getCurrentBlockNumber();
let lastScannedBlock = 0n;

const BLOCK_NUMBER_LEN = 16;
const padZero = (num: bigint) => num.toString().padStart(BLOCK_NUMBER_LEN, '0');

const replacer = (key: string, value: any) => {
    if (typeof value === 'bigint') {
        return value.toString();
    }
    return value;
};

while (lastBlockOnChain > lastScannedBlock) {
    const block = await fetchBlockAndReceipts(lastScannedBlock + 1n);
    await fs.promises.writeFile(`./data/blocks/${padZero(block.block.number)}.json`, JSON.stringify(block, replacer, 2));
    lastScannedBlock = block.block.number;
}
