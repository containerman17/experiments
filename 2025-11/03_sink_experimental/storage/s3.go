package storage

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/klauspost/compress/zstd"
)

const (
	BatchSize = 100 // blocks per S3 file
)

// BatchStart returns the first block of the batch containing blockNum
// Batches are 1-based: 1-100, 101-200, etc.
func BatchStart(blockNum uint64) uint64 {
	if blockNum == 0 {
		return 1
	}
	return ((blockNum-1)/BatchSize)*BatchSize + 1
}

// BatchEnd returns the last block of the batch starting at batchStart
func BatchEnd(batchStart uint64) uint64 {
	return batchStart + BatchSize - 1
}

type S3Client struct {
	client *s3.Client
	bucket string
}

type S3Config struct {
	Bucket    string
	Region    string
	Endpoint  string // Custom endpoint for R2/MinIO (e.g., "https://xxx.r2.cloudflarestorage.com")
	AccessKey string // Optional if using env vars
	SecretKey string // Optional if using env vars
}

func NewS3Client(ctx context.Context, cfg S3Config) (*S3Client, error) {
	var opts []func(*config.LoadOptions) error
	opts = append(opts, config.WithRegion(cfg.Region))

	// Use static credentials if provided
	if cfg.AccessKey != "" && cfg.SecretKey != "" {
		opts = append(opts, config.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(cfg.AccessKey, cfg.SecretKey, ""),
		))
	}

	awsCfg, err := config.LoadDefaultConfig(ctx, opts...)
	if err != nil {
		return nil, fmt.Errorf("failed to load AWS config: %w", err)
	}

	// S3 client options
	var s3Opts []func(*s3.Options)

	// Custom endpoint for R2/MinIO/etc
	if cfg.Endpoint != "" {
		s3Opts = append(s3Opts, func(o *s3.Options) {
			o.BaseEndpoint = aws.String(cfg.Endpoint)
			o.UsePathStyle = true // R2 requires path-style
		})
	}

	return &S3Client{
		client: s3.NewFromConfig(awsCfg, s3Opts...),
		bucket: cfg.Bucket,
	}, nil
}

// S3Key generates the S3 key for a batch of blocks
// Format: {prefix}/{chainID}/{startBlock:020d}-{endBlock:020d}.jsonl.zstd
func S3Key(prefix string, chainID, startBlock, endBlock uint64) string {
	return fmt.Sprintf("%s/%d/%020d-%020d.jsonl.zstd", prefix, chainID, startBlock, endBlock)
}

// Upload compresses and uploads block data to S3
// blocks should be JSON-encoded NormalizedBlock data (one per entry)
// Returns the compressed size in bytes
func (c *S3Client) Upload(ctx context.Context, key string, blocks [][]byte) (int, error) {
	// Create JSONL content
	var buf bytes.Buffer
	zw, err := zstd.NewWriter(&buf, zstd.WithEncoderLevel(zstd.SpeedDefault))
	if err != nil {
		return 0, fmt.Errorf("failed to create zstd writer: %w", err)
	}

	for _, block := range blocks {
		if _, err := zw.Write(block); err != nil {
			zw.Close()
			return 0, fmt.Errorf("failed to write block: %w", err)
		}
		if _, err := zw.Write([]byte{'\n'}); err != nil {
			zw.Close()
			return 0, fmt.Errorf("failed to write newline: %w", err)
		}
	}

	if err := zw.Close(); err != nil {
		return 0, fmt.Errorf("failed to close zstd writer: %w", err)
	}

	compressedSize := buf.Len()

	// Upload to S3
	_, err = c.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(c.bucket),
		Key:         aws.String(key),
		Body:        bytes.NewReader(buf.Bytes()),
		ContentType: aws.String("application/zstd"),
	})
	if err != nil {
		return 0, fmt.Errorf("failed to upload to S3: %w", err)
	}

	return compressedSize, nil
}

// Download retrieves and decompresses block data from S3
// Returns slice of JSON-encoded NormalizedBlock data
func (c *S3Client) Download(ctx context.Context, key string) ([][]byte, error) {
	resp, err := c.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to download from S3: %w", err)
	}
	defer resp.Body.Close()

	// Read all content
	compressed, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read S3 response: %w", err)
	}

	// Decompress
	zr, err := zstd.NewReader(bytes.NewReader(compressed))
	if err != nil {
		return nil, fmt.Errorf("failed to create zstd reader: %w", err)
	}
	defer zr.Close()

	// Parse JSONL
	var blocks [][]byte
	scanner := bufio.NewScanner(zr)
	scanner.Buffer(make([]byte, 10*1024*1024), 10*1024*1024) // 10MB max line

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		block := make([]byte, len(line))
		copy(block, line)
		blocks = append(blocks, block)
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("failed to scan JSONL: %w", err)
	}

	return blocks, nil
}

// Exists checks if a key exists in S3
func (c *S3Client) Exists(ctx context.Context, key string) (bool, error) {
	_, err := c.client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		// Check if it's a "not found" error
		return false, nil
	}
	return true, nil
}

// FindLatestBatch finds the latest batch end block for a chain in S3
// Returns 0 if no batches found
func (c *S3Client) FindLatestBatch(ctx context.Context, prefix string, chainID uint64) (uint64, error) {
	// List objects with chain prefix, sorted lexicographically (which works due to zero-padding)
	chainPrefix := fmt.Sprintf("%s/%d/", prefix, chainID)

	var latestEndBlock uint64
	var continuationToken *string

	for {
		resp, err := c.client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
			Bucket:            aws.String(c.bucket),
			Prefix:            aws.String(chainPrefix),
			ContinuationToken: continuationToken,
		})
		if err != nil {
			return 0, fmt.Errorf("failed to list S3 objects: %w", err)
		}

		for _, obj := range resp.Contents {
			// Parse end block from key: prefix/chainID/00000000000000000000-00000000000000000099.jsonl.zstd
			var startBlock, endBlock uint64
			key := aws.ToString(obj.Key)
			// Extract just the filename
			var filename string
			if idx := len(chainPrefix); idx < len(key) {
				filename = key[idx:]
			}
			_, err := fmt.Sscanf(filename, "%020d-%020d.jsonl.zstd", &startBlock, &endBlock)
			if err != nil {
				continue // Skip malformed keys
			}
			if endBlock > latestEndBlock {
				latestEndBlock = endBlock
			}
		}

		if resp.IsTruncated == nil || !*resp.IsTruncated {
			break
		}
		continuationToken = resp.NextContinuationToken
	}

	return latestEndBlock, nil
}
