import type { StoredBlock } from "./types";
import { compress, decompress } from "./compressor";
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import type { BlockCacheStore } from "./types";

export class S3BlockStore implements BlockCacheStore {
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

    // Convert block number to storage key using simple padding
    private getKeyFromBlockNumber(blockNumber: number): string {
        return `${this.prefix}/${blockNumber.toString().padStart(12, '0')}.json.zstd`;
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

    async getBlock(blockNumber: number): Promise<StoredBlock | null> {
        const command = new GetObjectCommand({
            Bucket: this.bucket,
            Key: this.getKeyFromBlockNumber(blockNumber)
        });
        try {
            const response = await this.s3Client.send(command);
            const data = await response.Body?.transformToByteArray();
            if (!data) {
                // This case should ideally not be reached if S3 throws NoSuchKey for missing objects.
                // However, if Body is empty for other reasons, we treat it as not found.
                return null;
            }
            return decompress(Buffer.from(data)) as Promise<StoredBlock>;
        } catch (error: any) {
            if (error.name === 'NoSuchKey') {
                return null;
            }
            // For other errors, re-throw
            throw error;
        }
    }
}
