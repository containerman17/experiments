export function median(arr: number[]): number {
    const sorted = arr.sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted[middle];
}

export function mean(arr: number[]): number {
    return arr.reduce((sum, value) => sum + value, 0) / arr.length;
}
