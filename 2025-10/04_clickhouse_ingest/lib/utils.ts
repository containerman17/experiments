// Zero-pad block numbers to xx digits for proper alphabetical sorting

export function padBlockNumber(blockNum: number): string {
    return blockNum.toString().padStart(10, '0');
}