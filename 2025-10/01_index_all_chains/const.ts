export const START_BLOCK = 55000000;

export function formatBlockNumber(blockNumber: number): string {
    return blockNumber.toString().padStart(12, '0');
}