package client

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"time"

	"github.com/klauspost/compress/zstd"
)

// BlockMessage received from server
type BlockMessage struct {
	Type        string          `json:"type"`
	ChainID     uint64          `json:"chain_id"`
	BlockNumber uint64          `json:"block_number"`
	Data        json.RawMessage `json:"data"`
}

// StatusMessage received from server
type StatusMessage struct {
	Type      string `json:"type"`
	Status    string `json:"status"`
	HeadBlock uint64 `json:"head_block"`
}

// ChainInfo from server
type ChainInfo struct {
	ChainID     uint64 `json:"chain_id"`
	Name        string `json:"name"`
	LatestBlock uint64 `json:"latest_block"`
}

// ChainsResponse from server
type ChainsResponse struct {
	Type   string      `json:"type"`
	Chains []ChainInfo `json:"chains"`
}

// Message is a union of all message types
type Message struct {
	Type        string          `json:"type"`
	ChainID     uint64          `json:"chain_id,omitempty"`
	BlockNumber uint64          `json:"block_number,omitempty"`
	Data        json.RawMessage `json:"data,omitempty"`
	Status      string          `json:"status,omitempty"`
	HeadBlock   uint64          `json:"head_block,omitempty"`
	Message     string          `json:"message,omitempty"`
}

// Client connects to an EVM sink and streams blocks
type Client struct {
	addr      string
	chainID   uint64
	conn      net.Conn
	zr        *zstd.Decoder
	zw        *zstd.Encoder
	reader    *bufio.Reader
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
	c := &Client{
		addr:      addr,
		chainID:   chainID,
		reconnect: true,
	}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

// GetChains fetches the list of available chains from the server
func GetChains(ctx context.Context, addr string) ([]ChainInfo, error) {
	dialer := net.Dialer{Timeout: 10 * time.Second}
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("failed to connect: %w", err)
	}
	defer conn.Close()

	// Set read deadline for the response
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))

	// Wrap in zstd
	zw, err := zstd.NewWriter(conn, zstd.WithEncoderLevel(zstd.SpeedFastest))
	if err != nil {
		return nil, fmt.Errorf("failed to create zstd writer: %w", err)
	}
	defer zw.Close()

	zr, err := zstd.NewReader(conn)
	if err != nil {
		return nil, fmt.Errorf("failed to create zstd reader: %w", err)
	}
	defer zr.Close()

	// Send list_chains command
	cmd := struct {
		Type string `json:"type"`
	}{Type: "list_chains"}

	data, _ := json.Marshal(cmd)
	if _, err := zw.Write(append(data, '\n')); err != nil {
		return nil, fmt.Errorf("failed to send command: %w", err)
	}
	if err := zw.Flush(); err != nil {
		return nil, fmt.Errorf("failed to flush command: %w", err)
	}

	// Read response
	reader := bufio.NewReader(zr)
	line, err := reader.ReadBytes('\n')
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	var resp ChainsResponse
	if err := json.Unmarshal(line, &resp); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	if resp.Type == "error" {
		return nil, fmt.Errorf("server error")
	}

	return resp.Chains, nil
}

// Connect establishes connection and sends greeting
func (c *Client) Connect(ctx context.Context, fromBlock uint64) error {
	var d net.Dialer
	conn, err := d.DialContext(ctx, "tcp", c.addr)
	if err != nil {
		return fmt.Errorf("failed to connect: %w", err)
	}
	c.conn = conn

	// Wrap in zstd
	c.zw, err = zstd.NewWriter(conn, zstd.WithEncoderLevel(zstd.SpeedFastest))
	if err != nil {
		conn.Close()
		return fmt.Errorf("failed to create zstd writer: %w", err)
	}

	c.zr, err = zstd.NewReader(conn)
	if err != nil {
		c.zw.Close()
		conn.Close()
		return fmt.Errorf("failed to create zstd reader: %w", err)
	}

	c.reader = bufio.NewReader(c.zr)

	// Send greeting
	greeting := struct {
		ChainID   uint64 `json:"chain_id"`
		FromBlock uint64 `json:"from_block"`
	}{
		ChainID:   c.chainID,
		FromBlock: fromBlock,
	}

	data, err := json.Marshal(greeting)
	if err != nil {
		c.Close()
		return fmt.Errorf("failed to marshal greeting: %w", err)
	}

	if _, err := c.zw.Write(append(data, '\n')); err != nil {
		c.Close()
		return fmt.Errorf("failed to send greeting: %w", err)
	}
	c.zw.Flush()

	return nil
}

// Close closes the connection
func (c *Client) Close() error {
	if c.zr != nil {
		c.zr.Close()
		c.zr = nil
	}
	if c.zw != nil {
		c.zw.Close()
		c.zw = nil
	}
	if c.conn != nil {
		err := c.conn.Close()
		c.conn = nil
		return err
	}
	return nil
}

// ReadMessage reads the next message from the server
func (c *Client) ReadMessage() (*Message, error) {
	line, err := c.reader.ReadBytes('\n')
	if err != nil {
		return nil, err
	}

	var msg Message
	if err := json.Unmarshal(line, &msg); err != nil {
		return nil, fmt.Errorf("failed to unmarshal message: %w", err)
	}

	if msg.Type == "error" {
		return nil, fmt.Errorf("server error: %s", msg.Message)
	}

	return &msg, nil
}

// StreamConfig configures the stream
type StreamConfig struct {
	FromBlock  uint64
	BufferSize int // Number of blocks to buffer
}

// BlockHandler is called for each received block
type BlockHandler func(chainID, blockNumber uint64, data json.RawMessage) error

// Stream connects and streams blocks, calling handler for each block
// Automatically reconnects on disconnect if enabled
func (c *Client) Stream(ctx context.Context, cfg StreamConfig, handler BlockHandler) error {
	if cfg.BufferSize <= 0 {
		cfg.BufferSize = 100
	}

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

			msg, err := c.ReadMessage()
			if err != nil {
				c.Close()
				if !c.reconnect {
					return err
				}
				time.Sleep(5 * time.Second)
				break // Reconnect
			}

			switch msg.Type {
			case "block":
				if err := handler(msg.ChainID, msg.BlockNumber, msg.Data); err != nil {
					c.Close()
					return err
				}
				currentBlock = msg.BlockNumber + 1

			case "status":
				// At tip, just continue reading
				continue

			case "error":
				c.Close()
				return fmt.Errorf("server error: %s", msg.Message)
			}
		}
	}
}

// StreamBlocks is a convenience method that returns a channel of blocks
func (c *Client) StreamBlocks(ctx context.Context, fromBlock uint64) (<-chan *BlockMessage, <-chan error) {
	blocks := make(chan *BlockMessage, 100)
	errs := make(chan error, 1)

	go func() {
		defer close(blocks)
		defer close(errs)

		err := c.Stream(ctx, StreamConfig{FromBlock: fromBlock}, func(chainID, blockNumber uint64, data json.RawMessage) error {
			select {
			case blocks <- &BlockMessage{
				Type:        "block",
				ChainID:     chainID,
				BlockNumber: blockNumber,
				Data:        data,
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

// Ensure io package is used (for interface compliance if needed)
var _ io.Reader = (*zstd.Decoder)(nil)
