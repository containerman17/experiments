import type { ArchivedBlock } from "./types.ts";
import { promises as fs } from "fs";
import { spawn } from "child_process";
import * as path from "path";
import * as readline from "readline";
import { padBlockNumber } from "./utils.ts";


/*
Reader for archived blocks. Reads compressed archives only, no temp file following.
Periodically rescans for new archives.
*/

export class LocalBlockReader {
    private readonly folder: string;
    private lastReadBlock: number = -1;

    constructor(folder: string, startFromBlock?: number) {
        this.folder = folder;
        this.lastReadBlock = startFromBlock ?? -1;
    }

    async *blocks(): AsyncGenerator<ArchivedBlock> {
        while (true) {
            const archives = await this.scanFiles();

            if (archives.length === 0) {
                // No archives to read, wait and retry
                console.log(`Waiting for archives (last block: ${this.lastReadBlock})...`);
                await new Promise(resolve => setTimeout(resolve, 1000));
                continue;
            }

            for (const archivePath of archives) {
                console.log(`Reading archive: ${path.basename(archivePath)}`);

                // Decompress and stream the file
                const zstd = spawn('zstd', ['-d', '-c', archivePath]);

                const rl = readline.createInterface({
                    input: zstd.stdout,
                    crlfDelay: Infinity
                });

                for await (const line of rl) {
                    if (line.trim()) {
                        try {
                            const block: ArchivedBlock = JSON.parse(line);
                            const blockNum = Number(block.block.number);

                            // Skip blocks we've already read
                            if (blockNum <= this.lastReadBlock) continue;

                            this.lastReadBlock = blockNum;
                            yield block;
                        } catch (e) {
                            throw new Error(`Failed to parse block: ${line}`);
                        }
                    }
                }

                // Ensure process is killed
                zstd.kill();
            }

            // After reading all available archives, wait a bit before checking for new ones
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    private async scanFiles(): Promise<string[]> {
        const files = await fs.readdir(this.folder);

        // The next archive should start at lastReadBlock + 1
        const expectedStart = this.lastReadBlock + 1;

        // Look for file matching pattern: <expectedStart>-*.jsonl.zstd (with zero-padding)
        const pattern = `${padBlockNumber(expectedStart)}-`;
        const nextArchive = files.find(f =>
            f.startsWith(pattern) && f.endsWith('.jsonl.zstd')
        );

        if (nextArchive) {
            return [path.join(this.folder, nextArchive)];
        }

        // Fallback: find any archive that starts after lastReadBlock
        // This handles initial startup or gaps
        const archives = files
            .filter(f => f.endsWith('.jsonl.zstd'))
            .map(f => {
                const match = f.match(/^(\d+)-(\d+)/);
                if (match) {
                    return {
                        name: f,
                        start: parseInt(match[1]),
                        end: parseInt(match[2])
                    };
                }
                return null;
            })
            .filter(a => a !== null)
            .sort((a, b) => a!.start - b!.start);

        for (const archive of archives) {
            // Find first archive where end > lastReadBlock
            // This ensures we don't re-read archives we've already finished
            if (archive!.end > this.lastReadBlock) {
                return [path.join(this.folder, archive!.name)];
            }
        }

        return [];
    }

    getLastReadBlock(): number {
        return this.lastReadBlock;
    }
}