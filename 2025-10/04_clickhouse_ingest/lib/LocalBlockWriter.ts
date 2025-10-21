import type { ArchivedBlock } from "./types.ts";
import { createWriteStream, WriteStream } from "fs";
import { promises as fs } from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";
import { padBlockNumber } from "./utils.ts";

const execAsync = promisify(exec);

/*
Writes blocks to a local folder. At first, writes them into a one jsonl file,
when jsonl is over sizeCutoffMB, archives the file, and creates a new one.

File naming: <startBlockNumber>-<endBlockNumber>.jsonl.zstd for the jsonl file, 
and <startBlockNumber>-temp.jsonl for the unfinished file.
Block numbers are zero-padded to 11 digits for proper alphabetical sorting.

When using rsync for backups, exclude *temp* files.
*/

export class LocalBlockWriter {
    private readonly folder: string;
    private readonly sizeCutoffBytes: number;
    private stream: WriteStream | null = null;
    private currentFile: string | null = null;
    private currentStartBlock: number | null = null;
    private lastWrittenBlock: number = 0;
    private lastFlushedBlock: number = 0;  // Track what's actually on disk
    private bytesWritten: number = 0;
    private writeQueue: string[] = [];
    private isWriting: boolean = false;
    private flushTimer: NodeJS.Timeout | null = null;
    private readonly flushInterval: number = 100; // ms
    private readyPromise: Promise<void>;

    constructor(folder: string, sizeCutoffMB: number) {
        this.folder = folder;
        this.sizeCutoffBytes = sizeCutoffMB * 1024 * 1024;
        this.readyPromise = this.initialize();
    }

    async ready(): Promise<void> {
        await this.readyPromise;
    }

    private async initialize() {
        try {
            await fs.mkdir(this.folder, { recursive: true });
            await this.loadLastWrittenBlock();
        } catch (error) {
            console.error('Failed to initialize LocalBlockWriter:', error);
            process.exit(1);
        }
    }

    private async loadLastWrittenBlock() {
        const files = await fs.readdir(this.folder);

        // Find completed archives
        const archives = files
            .filter(f => f.endsWith('.jsonl.zstd'))
            .sort();

        if (archives.length > 0) {
            const lastArchive = archives[archives.length - 1];
            const match = lastArchive.match(/^\d+-(\d+)/);
            if (match) {
                this.lastWrittenBlock = parseInt(match[1]);
                this.lastFlushedBlock = this.lastWrittenBlock; // Archives are already flushed
            }
        }

        // Check for existing temp file
        const tempFiles = files.filter(f => f.includes('-temp.jsonl'));
        if (tempFiles.length > 0) {
            const tempFile = tempFiles[0];
            const tempPath = path.join(this.folder, tempFile);

            // Parse start block from filename
            const match = tempFile.match(/^(\d+)-temp/);
            if (match) {
                this.currentStartBlock = parseInt(match[1]);
                this.currentFile = tempPath;

                // Get last block number from file content
                const content = await fs.readFile(tempPath, 'utf-8');
                const lines = content.trim().split('\n').filter(l => l);
                if (lines.length > 0) {
                    try {
                        const lastBlock = JSON.parse(lines[lines.length - 1]);
                        this.lastWrittenBlock = Number(lastBlock.block.number);
                        this.lastFlushedBlock = this.lastWrittenBlock; // Already on disk
                    } catch (e) {
                        // Corrupted last line, ignore
                    }
                }

                // Get file size and reopen for appending
                const stats = await fs.stat(tempPath);
                this.bytesWritten = stats.size;
                this.stream = createWriteStream(tempPath, { flags: 'a' });
                this.setupStreamHandlers();
            }
        }
    }

    writeBlock(block: ArchivedBlock): void {
        const blockNumber = Number(block.block.number);

        // Set start block for new file if needed
        if (!this.stream && this.currentStartBlock === null) {
            this.currentStartBlock = blockNumber;
        }

        // Queue the write - BigInt serialization
        const line = JSON.stringify(block, (_, value) =>
            typeof value === 'bigint' ? value.toString() : value
        ) + '\n';
        this.writeQueue.push(line);

        // Update tracking
        this.lastWrittenBlock = blockNumber;

        // Start or reset flush timer
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
        }
        this.flushTimer = setTimeout(() => this.flush(), this.flushInterval);

        // Flush immediately if queue is getting large (>1MB)
        const queueSize = this.writeQueue.reduce((sum, line) => sum + line.length, 0);
        if (queueSize > 1024 * 1024) {
            this.flush();
        }
    }

    private flush(): void {
        if (this.isWriting || this.writeQueue.length === 0) {
            return;
        }

        this.isWriting = true;
        const toWrite = this.writeQueue.splice(0);
        const buffer = toWrite.join('');

        // Need new file?
        if (!this.stream || this.bytesWritten >= this.sizeCutoffBytes) {
            this.rotateFile().then(() => {
                // Set start block for the new file based on current position
                if (this.currentStartBlock === null) {
                    this.currentStartBlock = this.lastFlushedBlock + 1;
                }
                this.writeToStream(buffer);
            }).catch(error => {
                console.error('Failed to rotate file:', error);
                process.exit(1);
            });
        } else {
            this.writeToStream(buffer);
        }
    }

    private writeToStream(buffer: string): void {
        if (!this.stream) {
            if (this.currentStartBlock === null) {
                throw new Error('currentStartBlock should be set before writing');
            }
            this.currentFile = path.join(this.folder, `${padBlockNumber(this.currentStartBlock)}-temp.jsonl`);
            this.stream = createWriteStream(this.currentFile);
            this.bytesWritten = 0;
            this.setupStreamHandlers();
        }

        const bytes = Buffer.byteLength(buffer);
        this.bytesWritten += bytes;

        // Update lastFlushedBlock to the last block we're actually writing
        this.lastFlushedBlock = this.lastWrittenBlock;

        if (!this.stream.write(buffer)) {
            // Wait for drain event
            this.stream.once('drain', () => {
                this.isWriting = false;
                if (this.writeQueue.length > 0) {
                    this.flush();
                }
            });
        } else {
            this.isWriting = false;
            if (this.writeQueue.length > 0) {
                setImmediate(() => this.flush());
            }
        }
    }

    private setupStreamHandlers(): void {
        if (!this.stream) return;

        this.stream.on('error', (error) => {
            console.error('Write stream error:', error);
            process.exit(1);
        });
    }

    private async rotateFile(): Promise<void> {
        if (!this.stream || !this.currentFile || this.currentStartBlock === null) {
            return;
        }

        // Close current stream
        await new Promise<void>((resolve, reject) => {
            this.stream!.end((err: any) => {
                if (err) reject(err);
                else resolve();
            });
        });

        // Compress the file - use lastFlushedBlock for the actual end block
        const finalName = `${padBlockNumber(this.currentStartBlock)}-${padBlockNumber(this.lastFlushedBlock)}.jsonl`;
        const finalPath = path.join(this.folder, finalName);
        const compressedPath = `${finalPath}.zstd`;

        // Rename temp to final
        await fs.rename(this.currentFile, finalPath);

        // Compress with zstd (remove original)
        try {
            await execAsync(`zstd -q --rm "${finalPath}" -o "${compressedPath}"`);
        } catch (error) {
            console.error('Failed to compress file:', error);
            // Try to restore the original file
            try {
                await fs.rename(finalPath, this.currentFile);
            } catch { }
            throw error;
        }

        // Reset state
        this.stream = null;
        this.currentFile = null;
        this.currentStartBlock = null;
        this.bytesWritten = 0;
    }

    getLastWrittenBlock(): number {
        return this.lastWrittenBlock;
    }

    async close(): Promise<void> {
        // Clear flush timer
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
        }

        // Flush remaining data
        if (this.writeQueue.length > 0) {
            this.flush();

            // Wait for writing to complete
            while (this.isWriting) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        }

        // Close stream
        if (this.stream) {
            await new Promise<void>((resolve) => {
                this.stream!.end(() => resolve());
            });
        }
    }
}
