package client

import (
	"bytes"
	"context"
	"encoding/json"
	"evm-sink/rpc"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/klauspost/compress/zstd"
)

// ChainInfo from server
type ChainInfo struct {
	ChainID     uint64 `json:"chain_id"`
	Name        string `json:"name"`
	LatestBlock uint64 `json:"latest_block"`
}

// Block represents a received block with its parsed data
type Block struct {
	Number uint64
	Data   *rpc.NormalizedBlock
}

// Client connects to an EVM sink and streams blocks
type Client struct {
	addr      string
	chainID   uint64
	conn      *websocket.Conn
	zstdDec   *zstd.Decoder
	reconnect bool
}

// Option configures the client
type Option func(*Client)

// WithReconnect enables automatic reconnection
func WithReconnect(enabled bool) Option {
	return func(c *Client) {
		c.reconnect = enabled
	}
}

// NewClient creates a new sink client
func NewClient(addr string, chainID uint64, opts ...Option) *Client {
	dec, _ := zstd.NewReader(nil)
	c := &Client{
		addr:      addr,
		chainID:   chainID,
		reconnect: true,
		zstdDec:   dec,
	}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

// GetChains fetches the list of available chains from the server via HTTP
func GetChains(ctx context.Context, addr string) ([]ChainInfo, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", "http://"+addr+"/chains", nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch chains: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("server returned status %d", resp.StatusCode)
	}

	var chains []ChainInfo
	if err := json.NewDecoder(resp.Body).Decode(&chains); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	return chains, nil
}

// Connect establishes WebSocket connection
func (c *Client) Connect(ctx context.Context, fromBlock uint64) error {
	url := fmt.Sprintf("ws://%s/ws?chain=%d&from=%d", c.addr, c.chainID, fromBlock)

	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
	}

	conn, _, err := dialer.DialContext(ctx, url, nil)
	if err != nil {
		return fmt.Errorf("failed to connect: %w", err)
	}
	c.conn = conn

	return nil
}

// Close closes the connection
func (c *Client) Close() error {
	if c.conn != nil {
		err := c.conn.Close()
		c.conn = nil
		return err
	}
	return nil
}

// parseBlockNumber parses hex block number string to uint64
func parseBlockNumber(hexNum string) (uint64, error) {
	numStr := strings.TrimPrefix(hexNum, "0x")
	return strconv.ParseUint(numStr, 16, 64)
}

// ReadBlocks reads the next binary frame and returns parsed blocks
// A single frame may contain 1-100 blocks
func (c *Client) ReadBlocks() ([]Block, error) {
	_, data, err := c.conn.ReadMessage()
	if err != nil {
		return nil, err
	}

	// Decompress
	decompressed, err := c.zstdDec.DecodeAll(data, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to decompress: %w", err)
	}

	// Parse JSONL - each line is a NormalizedBlock
	var blocks []Block
	for _, line := range bytes.Split(decompressed, []byte{'\n'}) {
		if len(line) == 0 {
			continue
		}
		var nb rpc.NormalizedBlock
		if err := json.Unmarshal(line, &nb); err != nil {
			return nil, fmt.Errorf("failed to parse block: %w", err)
		}
		blockNum, err := parseBlockNumber(nb.Block.Number)
		if err != nil {
			return nil, fmt.Errorf("failed to parse block number: %w", err)
		}
		blocks = append(blocks, Block{
			Number: blockNum,
			Data:   &nb,
		})
	}

	return blocks, nil
}

// StreamConfig configures the stream
type StreamConfig struct {
	FromBlock uint64
}

// BlockHandler is called for each received block
type BlockHandler func(blockNumber uint64, data *rpc.NormalizedBlock) error

// Stream connects and streams blocks, calling handler for each block
// Automatically reconnects on disconnect if enabled
func (c *Client) Stream(ctx context.Context, cfg StreamConfig, handler BlockHandler) error {
	currentBlock := cfg.FromBlock

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		// Connect
		if err := c.Connect(ctx, currentBlock); err != nil {
			if !c.reconnect {
				return err
			}
			time.Sleep(5 * time.Second)
			continue
		}

		// Stream blocks
		for {
			select {
			case <-ctx.Done():
				c.Close()
				return ctx.Err()
			default:
			}

			blocks, err := c.ReadBlocks()
			if err != nil {
				c.Close()
				if !c.reconnect {
					return err
				}
				time.Sleep(5 * time.Second)
				break // Reconnect
			}

			for _, block := range blocks {
				// Filter blocks below our fromBlock (handles unaligned S3 batch start)
				if block.Number < currentBlock {
					continue
				}
				if err := handler(block.Number, block.Data); err != nil {
					c.Close()
					return err
				}
				currentBlock = block.Number + 1
			}
		}
	}
}

// StreamBlocks is a convenience method that returns a channel of blocks
func (c *Client) StreamBlocks(ctx context.Context, fromBlock uint64) (<-chan *Block, <-chan error) {
	blocks := make(chan *Block, 100)
	errs := make(chan error, 1)

	go func() {
		defer close(blocks)
		defer close(errs)

		err := c.Stream(ctx, StreamConfig{FromBlock: fromBlock}, func(blockNumber uint64, data *rpc.NormalizedBlock) error {
			select {
			case blocks <- &Block{
				Number: blockNumber,
				Data:   data,
			}:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})

		if err != nil && err != context.Canceled {
			errs <- err
		}
	}()

	return blocks, errs
}
