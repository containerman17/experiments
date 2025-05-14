import type { HoarderDB } from "./types";
import type { StoredBlock } from "./types";
import { compress, decompress } from "./compressor";
import { promises as fs } from 'fs';
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

// Maximum value for a 32-bit unsigned integer
const MAX_BLOCK_NUMBER = 1000000000;

export class S3BlockStore implements HoarderDB {
    private bucket: string;
    private s3Client: S3Client;

    constructor(private prefix: string) {
        if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY || !process.env.AWS_BUCKET) {
            throw new Error('AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_BUCKET must be set');
        }
        this.s3Client = new S3Client({
            endpoint: process.env.AWS_ENDPOINT_URL_S3,
            region: process.env.AWS_REGION,
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!
            }
        });
        this.bucket = process.env.AWS_BUCKET!;
    }

    // Convert block number to storage key using inverted ordering
    private getKeyFromBlockNumber(blockNumber: number): string {
        // Store blocks as MAX_UINT32 - blockNumber to enable quick retrieval of latest blocks
        // when listing objects in ascending order
        const invertedNumber = MAX_BLOCK_NUMBER - blockNumber;
        return `${this.prefix}/${invertedNumber.toString().padStart(10, '0')}.json.zstd`;
    }

    // Convert storage key back to block number
    private getBlockNumberFromKey(key: string): number {
        const filename = key.split('/').pop() || '';
        const invertedNumber = parseInt(filename.split('.')[0] || '0', 10);
        return MAX_BLOCK_NUMBER - invertedNumber;
    }

    async storeBlock(blockNumber: number, block: StoredBlock): Promise<void> {
        const data = await compress(block);
        const command = new PutObjectCommand({
            Bucket: this.bucket,
            Key: this.getKeyFromBlockNumber(blockNumber),
            Body: data
        });
        await this.s3Client.send(command);
    }

    async getBlock(blockNumber: number): Promise<StoredBlock> {
        const command = new GetObjectCommand({
            Bucket: this.bucket,
            Key: this.getKeyFromBlockNumber(blockNumber)
        });
        const response = await this.s3Client.send(command);
        const data = await response.Body?.transformToByteArray();
        if (!data) {
            throw new Error(`Block ${blockNumber} not found`);
        }
        return decompress(Buffer.from(data)) as Promise<StoredBlock>;
    }

    async getLastStoredBlockNumber(): Promise<number> {
        // List objects with prefix and get the first one when sorted ascending
        // The inverted numbering scheme (MAX_UINT32 - blockNumber) ensures 
        // that the smallest key value corresponds to the highest block number
        const command = new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: this.prefix + '/',
            MaxKeys: 1
        });

        const response = await this.s3Client.send(command);

        if (!response.Contents || response.Contents.length === 0) {
            throw new Error('No blocks found');
        }

        const key = response.Contents[0]!.Key;
        if (!key) {
            throw new Error('Invalid block key');
        }

        return this.getBlockNumberFromKey(key);
    }
}
