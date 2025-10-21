import type { ArchivedBlock } from "./types.ts";
import { promises as fs, createReadStream } from "fs";
import { spawn } from "child_process";
import * as path from "path";
import * as readline from "readline";
import { padBlockNumber } from "./utils.ts";

/*
Block-by-block reader for archived blocks. Internally loads entire compressed archives,
pre-buffers the next archive, and enforces strict block continuity.
Supports reading from both compressed .zstd and uncompressed .jsonl files,
including following actively written -temp.jsonl files.
*/

export interface BlockWithMetadata {
    block: ArchivedBlock;
    isLastInBatch: boolean;  // true when this is the last block in an archive/batch
}

export class LocalBlockReader {
    private folder: string;
    private lastBlockNumber: number;
    private readonly maxRetryWaitMs = 30000; // 30 seconds max wait
    private readonly initialRetryMs = 100;

    constructor(folder: string, startFromBlock: number = -1) {
        this.folder = folder;
        this.lastBlockNumber = startFromBlock;
    }

    async *blocks(): AsyncGenerator<BlockWithMetadata> {
        let currentBatch: ArchivedBlock[] = [];
        let currentIndex = 0;
        let nextBatchPromise: Promise<{ blocks: ArchivedBlock[], filePath: string }> | null = null;
        let currentFilePath: string | null = null;
        let lastReadPosition = 0; // Track position in temp files for incremental reads

        while (true) {
            // If we've exhausted the current batch, get the next one
            if (currentIndex >= currentBatch.length) {
                let batchData: { blocks: ArchivedBlock[], filePath: string };

                // Check if we were following a temp file
                const wasFollowingTemp = currentFilePath?.includes('-temp.jsonl') || false;

                if (wasFollowingTemp && currentFilePath) {
                    // Check if the temp file still exists and has grown
                    try {
                        const stats = await fs.stat(currentFilePath);
                        if (stats.size > lastReadPosition) {
                            // File has grown, read new blocks
                            const newBlocks = await this.loadJsonlFileIncremental(currentFilePath, lastReadPosition);
                            if (newBlocks.blocks.length > 0) {
                                lastReadPosition = newBlocks.bytesRead;
                                currentBatch = newBlocks.blocks;
                                currentIndex = 0;

                                // Validate and log
                                const firstBlockNum = Number(currentBatch[0].block.number);
                                const lastBlockNum = Number(currentBatch[currentBatch.length - 1].block.number);
                                // console.log(`Loaded incremental batch: blocks ${firstBlockNum}-${lastBlockNum} (${currentBatch.length} blocks) from ${path.basename(currentFilePath)}`);
                                this.lastBlockNumber = lastBlockNum;
                                continue;
                            }
                        }
                        // File hasn't grown, wait a bit
                        await new Promise(resolve => setTimeout(resolve, 500));
                        // Try to find the next file (temp might have been rotated)
                        const archiveInfo = await this.findNextArchive();
                        if (!archiveInfo) {
                            continue; // Keep waiting
                        }
                        if (archiveInfo.path === currentFilePath) {
                            continue; // Same temp file, keep waiting
                        }
                        // Found a new file, load it
                        batchData = await this.loadFile(archiveInfo.path, archiveInfo.type);
                        currentFilePath = batchData.filePath;
                        lastReadPosition = 0;
                    } catch (error: any) {
                        if (error.code === 'ENOENT') {
                            // Temp file was deleted, likely rotated - find the compressed version or next file
                            const archiveInfo = await this.findNextArchiveWithRetry();
                            if (!archiveInfo) {
                                return; // No more data
                            }
                            batchData = await this.loadFile(archiveInfo.path, archiveInfo.type);
                            currentFilePath = batchData.filePath;
                            lastReadPosition = 0;
                        } else {
                            throw error;
                        }
                    }
                } else if (nextBatchPromise) {
                    // Use pre-buffered batch if available
                    batchData = await nextBatchPromise;
                    nextBatchPromise = null;
                    currentFilePath = batchData.filePath;
                    lastReadPosition = 0;
                } else {
                    // No pre-buffered batch, load synchronously with retries
                    const archiveInfo = await this.findNextArchiveWithRetry();
                    if (!archiveInfo) {
                        // No more archives, we're done
                        return;
                    }
                    batchData = await this.loadFile(archiveInfo.path, archiveInfo.type);
                    currentFilePath = batchData.filePath;
                    lastReadPosition = 0;
                }

                currentBatch = batchData.blocks;
                currentIndex = 0;

                if (currentBatch.length === 0) {
                    // Empty archive, continue to next
                    continue;
                }

                // Filter out blocks we've already processed
                // This happens when a file contains a range and we've already read part of it
                const expectedBlockNum = this.lastBlockNumber + 1;
                currentBatch = currentBatch.filter(b => Number(b.block.number) >= expectedBlockNum);

                if (currentBatch.length === 0) {
                    // All blocks already processed, continue to next
                    continue;
                }

                // Validate block continuity
                const firstBlockNum = Number(currentBatch[0].block.number);

                if (this.lastBlockNumber !== -1 && firstBlockNum !== expectedBlockNum) {
                    throw new Error(
                        `Block gap detected! Expected block ${expectedBlockNum} but got ${firstBlockNum}`
                    );
                }

                const lastBlockNum = Number(currentBatch[currentBatch.length - 1].block.number);
                // console.log(`Loaded batch: blocks ${firstBlockNum}-${lastBlockNum} (${currentBatch.length} blocks) from ${path.basename(batchData.filePath)}`);

                // Update lastBlockNumber to the end of this batch so findNextArchive works correctly
                this.lastBlockNumber = lastBlockNum;

                // Start pre-loading the next batch if not following a live file
                const isLiveFollowing = batchData.filePath.includes('-temp.jsonl');
                if (!isLiveFollowing) {
                    const nextArchiveInfo = await this.findNextArchive();
                    if (nextArchiveInfo) {
                        nextBatchPromise = this.loadFile(nextArchiveInfo.path, nextArchiveInfo.type);
                    }
                }

                // Reset for yielding
                currentIndex = 0;
            }

            // Yield the next block from current batch
            const block = currentBatch[currentIndex];
            currentIndex++;

            // Check if this is the last block in the batch
            const isLastInBatch = currentIndex >= currentBatch.length;
            const isLiveFile = currentFilePath?.includes('-temp.jsonl') || false;

            yield {
                block,
                isLastInBatch: isLastInBatch && !isLiveFile // For live files, we don't know if it's truly the last
            };
        }
    }

    private async loadFile(filePath: string, fileType: 'zstd' | 'jsonl' | 'temp-jsonl'): Promise<{ blocks: ArchivedBlock[], filePath: string }> {
        let blocks: ArchivedBlock[];

        if (fileType === 'zstd') {
            blocks = await this.loadZstdArchive(filePath);
        } else {
            blocks = await this.loadJsonlFile(filePath, fileType === 'temp-jsonl');
        }

        return { blocks, filePath };
    }

    private async loadJsonlFileIncremental(jsonlPath: string, startPosition: number): Promise<{ blocks: ArchivedBlock[], bytesRead: number }> {
        const blocks: ArchivedBlock[] = [];
        let bytesRead = startPosition;

        try {
            // Read from specific position
            const stream = createReadStream(jsonlPath, {
                encoding: 'utf8',
                start: startPosition
            });

            const rl = readline.createInterface({
                input: stream,
                crlfDelay: Infinity
            });

            for await (const line of rl) {
                bytesRead += Buffer.byteLength(line + '\n', 'utf8');
                if (line.trim()) {
                    try {
                        const block: ArchivedBlock = JSON.parse(line);
                        blocks.push(block);
                    } catch (e) {
                        // Might be a partial line at the end
                        bytesRead -= Buffer.byteLength(line + '\n', 'utf8'); // Don't count partial line
                        break;
                    }
                }
            }

            // Sort blocks by number to ensure proper ordering
            blocks.sort((a, b) => Number(a.block.number) - Number(b.block.number));

            // Validate internal continuity if we got blocks
            if (blocks.length > 1) {
                for (let i = 1; i < blocks.length; i++) {
                    const prevNum = Number(blocks[i - 1].block.number);
                    const currNum = Number(blocks[i].block.number);
                    if (currNum !== prevNum + 1) {
                        throw new Error(
                            `Internal gap in file ${path.basename(jsonlPath)}: block ${prevNum} followed by ${currNum}`
                        );
                    }
                }
            }

            return { blocks, bytesRead };
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                // File disappeared
                return { blocks, bytesRead };
            }
            throw error;
        }
    }

    private async loadJsonlFile(jsonlPath: string, isTempFile: boolean = false): Promise<ArchivedBlock[]> {
        const blocks: ArchivedBlock[] = [];

        try {
            // For temp files, we might be reading while it's being written
            const stream = createReadStream(jsonlPath, { encoding: 'utf8' });
            const rl = readline.createInterface({
                input: stream,
                crlfDelay: Infinity
            });

            for await (const line of rl) {
                if (line.trim()) {
                    try {
                        const block: ArchivedBlock = JSON.parse(line);
                        blocks.push(block);
                    } catch (e) {
                        // For temp files, we might hit a partially written line at the end
                        if (isTempFile && blocks.length > 0) {
                            // Ignore the error for the last line of a temp file
                            console.log(`Ignoring partial line in temp file ${path.basename(jsonlPath)}`);
                            break;
                        }
                        throw new Error(`Failed to parse block in ${path.basename(jsonlPath)}: ${e}`);
                    }
                }
            }

            // Sort blocks by number to ensure proper ordering
            blocks.sort((a, b) => Number(a.block.number) - Number(b.block.number));

            // Validate internal continuity
            for (let i = 1; i < blocks.length; i++) {
                const prevNum = Number(blocks[i - 1].block.number);
                const currNum = Number(blocks[i].block.number);
                if (currNum !== prevNum + 1) {
                    throw new Error(
                        `Internal gap in file ${path.basename(jsonlPath)}: block ${prevNum} followed by ${currNum}`
                    );
                }
            }

            return blocks;
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                // File disappeared (probably being compressed)
                console.log(`File ${path.basename(jsonlPath)} disappeared, likely being compressed`);
                return blocks; // Return what we got so far
            }
            throw error;
        }
    }

    private async loadZstdArchive(archivePath: string): Promise<ArchivedBlock[]> {
        return new Promise((resolve, reject) => {
            const blocks: ArchivedBlock[] = [];

            // Decompress and stream the file
            const zstd = spawn('zstd', ['-d', '-c', archivePath]);

            const rl = readline.createInterface({
                input: zstd.stdout,
                crlfDelay: Infinity
            });

            rl.on('line', (line) => {
                if (line.trim()) {
                    try {
                        const block: ArchivedBlock = JSON.parse(line);
                        blocks.push(block);
                    } catch (e) {
                        zstd.kill();
                        reject(new Error(`Failed to parse block in ${path.basename(archivePath)}: ${e}`));
                    }
                }
            });

            rl.on('close', () => {
                // Sort blocks by number to ensure proper ordering
                blocks.sort((a, b) => Number(a.block.number) - Number(b.block.number));

                // Validate internal continuity
                for (let i = 1; i < blocks.length; i++) {
                    const prevNum = Number(blocks[i - 1].block.number);
                    const currNum = Number(blocks[i].block.number);
                    if (currNum !== prevNum + 1) {
                        reject(new Error(
                            `Internal gap in archive ${path.basename(archivePath)}: block ${prevNum} followed by ${currNum}`
                        ));
                        return;
                    }
                }

                resolve(blocks);
            });

            zstd.stderr.on('data', (data) => {
                reject(new Error(`zstd error for ${path.basename(archivePath)}: ${data}`));
            });

            zstd.on('error', (error) => {
                reject(new Error(`Failed to decompress ${path.basename(archivePath)}: ${error}`));
            });
        });
    }

    private async findNextArchiveWithRetry(): Promise<{ path: string, type: 'zstd' | 'jsonl' | 'temp-jsonl' } | null> {
        let retryMs = this.initialRetryMs;
        const startTime = Date.now();

        while (Date.now() - startTime < this.maxRetryWaitMs) {
            const archiveInfo = await this.findNextArchive();
            if (archiveInfo) {
                return archiveInfo;
            }

            // Wait with exponential backoff
            await new Promise(resolve => setTimeout(resolve, retryMs));
            retryMs = Math.min(retryMs * 2, 5000); // Cap at 5 seconds between retries
        }

        // Timeout reached
        console.log(`No new archive found after ${this.maxRetryWaitMs}ms, assuming end of data`);
        return null;
    }

    private async findNextArchive(): Promise<{ path: string, type: 'zstd' | 'jsonl' | 'temp-jsonl' } | null> {
        const files = await fs.readdir(this.folder);
        const expectedNextBlock = this.lastBlockNumber + 1;

        // Parse all archives and find ones that could contain our next block
        const archives = files
            .filter(f => f.endsWith('.jsonl.zstd') || f.endsWith('.jsonl'))
            .map(f => {
                const match = f.match(/^(\d+)-(\d+|temp)/);
                if (match) {
                    const start = parseInt(match[1]);
                    const isZstd = f.endsWith('.jsonl.zstd');
                    const isTemp = f.includes('-temp');
                    const end = isTemp ? Infinity : parseInt(match[2]);

                    return {
                        name: f,
                        start,
                        end,
                        type: isZstd ? 'zstd' : (isTemp ? 'temp-jsonl' : 'jsonl')
                    };
                }
                return null;
            })
            .filter(a => a !== null);

        // Fallback for initial startup when lastBlockNumber is -1
        if (this.lastBlockNumber === -1) {
            const sorted = archives.sort((a, b) => a!.start - b!.start);
            if (sorted.length > 0) {
                const archive = sorted[0]!;
                return {
                    path: path.join(this.folder, archive.name),
                    type: archive.type as 'zstd' | 'jsonl' | 'temp-jsonl'
                };
            }
            return null;
        }

        // Find archives that could contain the next block
        // An archive contains the block if: start <= expectedNextBlock <= end
        const candidates = archives.filter(a =>
            a!.start <= expectedNextBlock && expectedNextBlock <= a!.end
        );

        if (candidates.length === 0) {
            return null;
        }

        // Priority: zstd > jsonl > temp-jsonl
        const zstd = candidates.find(a => a!.type === 'zstd');
        if (zstd) {
            return { path: path.join(this.folder, zstd.name), type: 'zstd' };
        }

        const jsonl = candidates.find(a => a!.type === 'jsonl');
        if (jsonl) {
            return { path: path.join(this.folder, jsonl.name), type: 'jsonl' };
        }

        const temp = candidates.find(a => a!.type === 'temp-jsonl');
        if (temp) {
            return { path: path.join(this.folder, temp.name), type: 'temp-jsonl' };
        }

        return null;
    }

    getLastBlockNumber(): number {
        return this.lastBlockNumber;
    }
}