import { LocalBlockReader } from "./lib/LocalBlockReader.ts";
import type { ArchivedBlock, TraceResult, CallTrace } from "./lib/types.ts";
import { promises as fs } from "fs";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import * as path from "path";

const execAsync = promisify(exec);

const SOURCE_DIR = "/data/2q9e4r6Mu3U68nU1fYjgbR6JvwrRx36CohpAX5UQxse55x1Q5";
const TARGET_DIR = "/data/2q9e4r6Mu3U68nU1fYjgbR6JvwrRx36CohpAX5UQxse55x1Q5_v2";
const END_BLOCK = 70000000; // Set this to your target end block

interface TraceResultOptional {
    txHash: string;
    result: CallTrace | null;
}

interface NormalizedBlock {
    block: ArchivedBlock['block'];
    traces: TraceResultOptional[];
    receipts: ArchivedBlock['receipts'];
}

function die(message: string): never {
    console.error(`FATAL: ${message}`);
    process.exit(1);
}

function isTraceResult(obj: any): obj is TraceResult {
    return obj && typeof obj === 'object' && 'txHash' in obj && 'result' in obj;
}

function isCallTrace(obj: any): obj is CallTrace {
    return obj && typeof obj === 'object' &&
        'from' in obj && 'to' in obj && 'gas' in obj &&
        !('txHash' in obj);
}

function normalizeTraces(
    traces: ArchivedBlock['traces'],
    blockNumber: number,
    transactions: ArchivedBlock['block']['transactions']
): TraceResultOptional[] {
    const txHashes = transactions.map((tx, index) => {
        if (typeof tx === 'string') {
            die(`Block ${blockNumber}: Transaction at index ${index} is just a hash string, not a full transaction object!`);
        }
        if (!tx.hash) {
            die(`Block ${blockNumber}: Transaction at index ${index} has no hash!`);
        }
        return tx.hash;
    });

    // If no traces at all, that's bad data - DIE
    if (traces === undefined || traces === null) {
        die(`Block ${blockNumber}: traces is undefined/null - data corruption detected!`);
    }

    if (!Array.isArray(traces)) {
        die(`Block ${blockNumber}: traces is not an array`);
    }

    // Empty trace array is also bad unless block has no transactions
    if (traces.length === 0) {
        if (txHashes.length > 0) {
            die(`Block ${blockNumber}: has ${txHashes.length} transactions but no traces!`);
        }
        // Block with no transactions and no traces is valid
        return [];
    }

    // Validate count matches transactions
    if (traces.length !== txHashes.length) {
        die(`Block ${blockNumber}: Trace count (${traces.length}) doesn't match transaction count (${txHashes.length})`);
    }

    // Process each trace individually - 2x2 matrix: wrapped/unwrapped × trace/empty
    const normalized: TraceResultOptional[] = traces.map((trace, index) => {
        const txHash = txHashes[index];

        // Null/undefined check
        if (trace === null || trace === undefined) {
            die(`Block ${blockNumber}: Trace at index ${index} is null/undefined`);
        }

        // Must be an object
        if (typeof trace !== 'object') {
            die(`Block ${blockNumber}: Trace at index ${index} is not an object: ${typeof trace}`);
        }

        // Check if it's wrapped (has txHash field) or not
        const hasWrapper = 'txHash' in trace;

        if (hasWrapper) {
            // WRAPPED format: should have exactly {txHash, result}
            const wrapped = trace as any;

            // Validate structure
            if (!('result' in wrapped)) {
                die(`Block ${blockNumber}: Trace at index ${index} has txHash but no result field`);
            }

            // Validate txHash type
            if (typeof wrapped.txHash !== 'string') {
                die(`Block ${blockNumber}: Trace at index ${index} has invalid txHash type: ${typeof wrapped.txHash}`);
            }

            // Validate result is an object
            if (typeof wrapped.result !== 'object' || wrapped.result === null) {
                die(`Block ${blockNumber}: Trace at index ${index} has invalid result type: ${typeof wrapped.result}`);
            }

            // Check if result is empty object
            const isEmpty = Object.keys(wrapped.result).length === 0;

            if (isEmpty) {
                // Case: {txHash: "...", result: {}}
                return {
                    txHash: wrapped.txHash,
                    result: null
                };
            } else {
                // Case: {txHash: "...", result: <CallTrace>}
                // Validate it actually looks like a CallTrace
                const requiredFields = ['from', 'gas', 'gasUsed', 'input', 'value', 'type'];
                const missingFields = requiredFields.filter(field => !(field in wrapped.result));
                if (missingFields.length > 0) {
                    const resultKeys = Object.keys(wrapped.result);
                    die(`Block ${blockNumber}: Trace at index ${index} has wrapped result missing fields: [${missingFields.join(', ')}]. Has: [${resultKeys.join(', ')}]`);
                }

                return {
                    txHash: wrapped.txHash,
                    result: wrapped.result
                };
            }
        } else {
            // NOT WRAPPED - could be empty object or plain CallTrace
            const keys = Object.keys(trace);

            if (keys.length === 0) {
                // Case: {} (empty object)
                return {
                    txHash: txHash,
                    result: null
                };
            } else {
                // Case: Plain CallTrace - verify it looks like a trace
                const requiredFields = ['from', 'gas', 'gasUsed', 'input', 'value', 'type'];
                const missingFields = requiredFields.filter(field => !(field in trace));

                if (missingFields.length > 0) {
                    die(`Block ${blockNumber}: Trace at index ${index} is not wrapped, missing fields: [${missingFields.join(', ')}]. Has: [${keys.join(', ')}]`);
                }

                return {
                    txHash: txHash,
                    result: trace as CallTrace
                };
            }
        }
    });

    // Log statistics about the traces
    const failedCount = normalized.filter(t => t.result === null).length;
    if (failedCount > 0) {
        console.log(`Block ${blockNumber}: ${failedCount}/${normalized.length} traces have null results (known failures)`);
    }

    return normalized;
}

class MigrationWriter {
    private targetDir: string;
    private currentBatch: NormalizedBlock[] = [];
    private currentBatchStart: number | null = null;
    private lastWrittenBlock: number = 0;

    constructor(targetDir: string) {
        this.targetDir = targetDir;
    }

    async initialize() {
        await fs.mkdir(this.targetDir, { recursive: true });

        // Find last written block
        const millions = await this.findExistingMillions();
        if (millions.length > 0) {
            const lastMillion = Math.max(...millions);
            const lastFile = await this.findLastFileInMillion(lastMillion);
            if (lastFile) {
                this.lastWrittenBlock = lastFile;
                console.log(`Resuming from block ${this.lastWrittenBlock + 1}`);
            }
        }
    }

    private async findExistingMillions(): Promise<number[]> {
        try {
            const entries = await fs.readdir(this.targetDir);
            const millions: number[] = [];
            for (const entry of entries) {
                const stat = await fs.stat(path.join(this.targetDir, entry));
                if (stat.isDirectory()) {
                    const num = parseInt(entry);
                    if (!isNaN(num)) {
                        millions.push(num);
                    }
                }
            }
            return millions;
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                return [];
            }
            throw error;
        }
    }

    private async findLastFileInMillion(million: number): Promise<number | null> {
        const millionDir = path.join(this.targetDir, million.toString().padStart(4, '0'));
        try {
            const files = await fs.readdir(millionDir);
            const archives = files
                .filter(f => f.endsWith('.jsonl.zstd'))
                .map(f => {
                    const match = f.match(/^(\d+)xxx\.jsonl\.zstd$/);
                    if (match) {
                        const thousands = parseInt(match[1]);
                        const baseBlock = million * 1000000 + thousands * 1000;
                        // 000xxx contains blocks 1-999 (or 1000000-1000999, etc.)
                        // 001xxx contains blocks 1000-1999 (or 1001000-1001999, etc.)
                        // So end block is baseBlock + 999, except for 000xxx in million 0 which is just 999
                        if (million === 0 && thousands === 0) {
                            return 999;
                        } else {
                            return baseBlock + 999;
                        }
                    }
                    return null;
                })
                .filter(n => n !== null) as number[];

            return archives.length > 0 ? Math.max(...archives) : null;
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                return null;
            }
            throw error;
        }
    }

    async writeBlock(block: NormalizedBlock) {
        const blockNum = Number(block.block.number);

        // Validate block number
        if (blockNum !== this.lastWrittenBlock + 1) {
            die(`Block number discontinuity! Expected ${this.lastWrittenBlock + 1}, got ${blockNum}`);
        }

        // Validate required fields
        if (!block.block.hash || !block.block.number) {
            die(`Block ${blockNum}: Missing required fields (hash or number)`);
        }

        // Determine batch boundaries
        // Blocks 1-999: first batch (999 blocks)
        // Blocks 1000-1999, 2000-2999, etc: (1000 blocks each)
        let batchStart: number;
        let batchSize: number;

        if (blockNum <= 999) {
            batchStart = 1;
            batchSize = 999;
        } else {
            batchStart = Math.floor(blockNum / 1000) * 1000;
            batchSize = 1000;
        }

        // Start new batch if needed
        if (this.currentBatchStart === null) {
            this.currentBatchStart = batchStart;
        }

        if (this.currentBatchStart !== batchStart) {
            // Flush current batch
            await this.flushBatch();
            this.currentBatchStart = batchStart;
        }

        this.currentBatch.push(block);
        this.lastWrittenBlock = blockNum;

        // Flush if batch is complete
        if (this.currentBatch.length === batchSize) {
            await this.flushBatch();
        }
    }

    private async flushBatch() {
        if (this.currentBatch.length === 0) {
            return;
        }

        if (this.currentBatchStart === null) {
            die("currentBatchStart is null when flushing batch");
        }

        const firstBlock = Number(this.currentBatch[0].block.number);
        const lastBlock = Number(this.currentBatch[this.currentBatch.length - 1].block.number);

        // Determine expected batch size
        const expectedSize = firstBlock <= 999 ? 999 : 1000;

        // Only write complete batches
        if (this.currentBatch.length !== expectedSize) {
            console.log(`Skipping incomplete batch of ${this.currentBatch.length} blocks (expected ${expectedSize})`);
            console.log(`First block: ${firstBlock}, last block: ${lastBlock}`);
            return;
        }

        // Validate batch continuity
        for (let i = 0; i < this.currentBatch.length; i++) {
            const expected = firstBlock + i;
            const actual = Number(this.currentBatch[i].block.number);
            if (actual !== expected) {
                die(`Batch continuity broken at index ${i}: expected ${expected}, got ${actual}`);
            }
        }

        // Calculate file path
        // Blocks 1-999: 0000/000xxx.jsonl.zstd
        // Blocks 1000-1999: 0000/001xxx.jsonl.zstd
        // Blocks 2000-2999: 0000/002xxx.jsonl.zstd
        // Blocks 1000000-1000999: 0001/000xxx.jsonl.zstd
        const millions = Math.floor(firstBlock / 1000000);
        const thousands = Math.floor((firstBlock % 1000000) / 1000);

        const millionDir = path.join(this.targetDir, millions.toString().padStart(4, '0'));
        await fs.mkdir(millionDir, { recursive: true });

        const filename = `${thousands.toString().padStart(3, '0')}xxx.jsonl.zstd`;
        const zstdPath = path.join(millionDir, filename);

        // Check if file already exists
        try {
            await fs.access(zstdPath);
            die(`File ${zstdPath} already exists! Migration state is inconsistent.`);
        } catch {
            // File doesn't exist, good
        }

        // Compress directly from memory to zstd file
        const zstdProcess = spawn('zstd', ['-q', '-o', zstdPath], {
            stdio: ['pipe', 'inherit', 'inherit']
        });

        // Write blocks to zstd's stdin
        for (const block of this.currentBatch) {
            const line = JSON.stringify(block, (_, value) =>
                typeof value === 'bigint' ? value.toString() : value
            ) + '\n';

            if (!zstdProcess.stdin.write(line)) {
                await new Promise<void>((resolve) => zstdProcess.stdin.once('drain', resolve));
            }
        }

        // Close stdin and wait for zstd to finish
        await new Promise<void>((resolve, reject) => {
            zstdProcess.stdin.end();
            zstdProcess.on('exit', (code) => {
                if (code !== 0) {
                    reject(new Error(`zstd exited with code ${code}`));
                } else {
                    resolve();
                }
            });
            zstdProcess.on('error', reject);
        });

        // Verify compressed file exists
        try {
            await fs.access(zstdPath);
        } catch {
            die(`Compressed file ${zstdPath} doesn't exist after compression!`);
        }

        console.log(`Wrote blocks ${firstBlock}-${lastBlock} to ${path.basename(zstdPath)} (${this.currentBatch.length} blocks)`);

        // Reset batch
        this.currentBatch = [];
        this.currentBatchStart = null;
    }

    async close() {
        await this.flushBatch();
    }

    getLastWrittenBlock(): number {
        return this.lastWrittenBlock;
    }
}

async function main() {
    console.log('Starting migration...');
    console.log(`Source: ${SOURCE_DIR}`);
    console.log(`Target: ${TARGET_DIR}`);

    const writer = new MigrationWriter(TARGET_DIR);
    await writer.initialize();

    const startFrom = writer.getLastWrittenBlock();
    const startBlock = startFrom > 0 ? startFrom : 0; // Start from 0 means read from beginning (block 1)

    if (startFrom > 0) {
        console.log(`Resuming from block ${startFrom + 1}`);
    } else {
        console.log('Starting from block 1');
    }

    // Initialize reader starting from the last written block
    const reader = new LocalBlockReader(SOURCE_DIR, startBlock);

    let expectedBlockNum = startFrom + 1;
    let processedCount = 0;

    // Performance tracking
    let lastStatsTime = Date.now();
    let lastStatsBlock = startFrom;
    let totalTxs = 0;
    let lastStatsTxs = 0;
    let statsTimer = setInterval(() => {
        const now = Date.now();
        const elapsedSec = (now - lastStatsTime) / 1000;
        const blocksSinceLastStats = writer.getLastWrittenBlock() - lastStatsBlock;
        const blocksPerSec = blocksSinceLastStats / elapsedSec;
        const blocksPerHour = blocksPerSec * 3600;

        const txsSinceLastStats = totalTxs - lastStatsTxs;
        const txsPerSec = txsSinceLastStats / elapsedSec;
        const txsPerHour = txsPerSec * 3600;

        const currentBlock = writer.getLastWrittenBlock();
        const remainingBlocks = END_BLOCK - currentBlock;
        const etaSeconds = blocksPerSec > 0 ? remainingBlocks / blocksPerSec : 0;
        const etaHours = Math.floor(etaSeconds / 3600);
        const etaMinutes = Math.floor((etaSeconds % 3600) / 60);
        const etaStr = `${etaHours}h ${etaMinutes}m`;

        console.log(`Performance: ${blocksPerSec.toFixed(1)} blocks/sec, ${Number(blocksPerHour.toFixed(0)).toLocaleString()} blocks/hour, ${txsPerSec.toFixed(1)} txs/sec, ${Number(txsPerHour.toFixed(0)).toLocaleString()} txs/hour (block: ${currentBlock.toLocaleString()}/${END_BLOCK.toLocaleString()}, txs: ${totalTxs.toLocaleString()}, ETA: ${etaStr})`);

        lastStatsTime = now;
        lastStatsBlock = writer.getLastWrittenBlock();
        lastStatsTxs = totalTxs;
    }, 10000);

    try {
        for await (const { block: rawBlock } of reader.blocks()) {
            const blockNum = Number(rawBlock.block.number);

            // Validate block continuity
            if (blockNum !== expectedBlockNum) {
                die(`Block number gap! Expected ${expectedBlockNum}, got ${blockNum}`);
            }

            // Normalize traces
            const normalizedTraces = normalizeTraces(
                rawBlock.traces,
                blockNum,
                rawBlock.block.transactions || []
            );

            const normalizedBlock: NormalizedBlock = {
                block: rawBlock.block,
                traces: normalizedTraces,
                receipts: rawBlock.receipts
            };

            await writer.writeBlock(normalizedBlock);

            totalTxs += rawBlock.block.transactions?.length || 0;
            processedCount++;
            expectedBlockNum = blockNum + 1;

            if (processedCount % 10000 === 0) {
                console.log(`Processed ${processedCount} blocks (current: ${blockNum})`);
            }
        }

        await writer.close();
        clearInterval(statsTimer);
        console.log(`Migration complete! Processed ${processedCount} blocks, ${totalTxs.toLocaleString()} transactions.`);

    } catch (error) {
        clearInterval(statsTimer);
        console.error('Migration failed:', error);
        await writer.close();
        process.exit(1);
    }
}

main();

