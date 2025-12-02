package main

import (
	"bufio"
	"context"
	"encoding/json"
	"evm-sink/client"
	"flag"
	"fmt"
	"log"
	"net"
	"time"

	"github.com/klauspost/compress/zstd"
)

const (
	connectTimeout = 5 * time.Second
	readTimeout    = 30 * time.Second
	reconnectDelay = 2 * time.Second
)

func main() {
	fmt.Println("Starting example client")
	addr := flag.String("addr", "localhost:9090", "Server address")
	chainID := flag.Uint64("chain", 0, "Chain ID to stream (0 to list chains)")
	fromBlock := flag.Uint64("from", 1, "Starting block number")
	flag.Parse()

	ctx := context.Background()

	// If no chain specified, list available chains
	if *chainID == 0 {
		chains, err := client.GetChains(ctx, *addr)
		if err != nil {
			log.Fatalf("Failed to get chains: %v", err)
		}
		fmt.Println("Available chains:")
		for _, c := range chains {
			fmt.Printf("  Chain %d (%s) - latest block: %d\n", c.ChainID, c.Name, c.LatestBlock)
		}
		fmt.Println("\nUse -chain=<id> to stream a chain")
		return
	}

	// Stats tracking
	startTime := time.Now()
	totalBlocks := uint64(0)
	lastLogTime := time.Now()
	lastLogBlocks := uint64(0)
	lastBlock := *fromBlock - 1

	// Reconnection loop
	for {
		nextBlock := lastBlock + 1
		fmt.Printf("[%s] Connecting to %s, chain %d, from block %d...\n",
			time.Now().Format("15:04:05"), *addr, *chainID, nextBlock)

		err := streamBlocks(ctx, *addr, *chainID, nextBlock, func(blockNum uint64, data json.RawMessage) error {
			// Validate order
			if blockNum != lastBlock+1 {
				log.Fatalf("FATAL: Expected block %d, got %d", lastBlock+1, blockNum)
			}
			lastBlock = blockNum
			totalBlocks++

			// Log every second
			if time.Since(lastLogTime) >= time.Second {
				now := time.Now()
				recentBlocks := totalBlocks - lastLogBlocks
				recentElapsed := now.Sub(lastLogTime).Seconds()
				recentRate := float64(recentBlocks) / recentElapsed

				totalElapsed := now.Sub(startTime).Seconds()
				avgRate := float64(totalBlocks) / totalElapsed

				fmt.Printf("Block %d | %.1f blk/s recent | %.1f blk/s avg | %d total\n",
					blockNum, recentRate, avgRate, totalBlocks)

				lastLogTime = now
				lastLogBlocks = totalBlocks
			}
			return nil
		})

		if err != nil {
			fmt.Printf("[%s] Disconnected: %v. Reconnecting in %v...\n",
				time.Now().Format("15:04:05"), err, reconnectDelay)
			time.Sleep(reconnectDelay)
		}
	}
}

func streamBlocks(ctx context.Context, addr string, chainID, fromBlock uint64, handler func(uint64, json.RawMessage) error) error {
	// Connect with timeout
	dialer := net.Dialer{Timeout: connectTimeout}
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return fmt.Errorf("connect failed: %w", err)
	}
	defer conn.Close()

	// Wrap in zstd
	zw, err := zstd.NewWriter(conn, zstd.WithEncoderLevel(zstd.SpeedFastest))
	if err != nil {
		return fmt.Errorf("zstd writer failed: %w", err)
	}
	defer zw.Close()

	zr, err := zstd.NewReader(conn)
	if err != nil {
		return fmt.Errorf("zstd reader failed: %w", err)
	}
	defer zr.Close()

	// Send greeting
	greeting := struct {
		ChainID   uint64 `json:"chain_id"`
		FromBlock uint64 `json:"from_block"`
	}{ChainID: chainID, FromBlock: fromBlock}

	data, _ := json.Marshal(greeting)
	if _, err := zw.Write(append(data, '\n')); err != nil {
		return fmt.Errorf("send greeting failed: %w", err)
	}
	if err := zw.Flush(); err != nil {
		return fmt.Errorf("flush greeting failed: %w", err)
	}

	reader := bufio.NewReader(zr)

	// Stream blocks
	for {
		// Set read deadline for each message
		conn.SetReadDeadline(time.Now().Add(readTimeout))

		line, err := reader.ReadBytes('\n')
		if err != nil {
			return fmt.Errorf("read failed: %w", err)
		}

		var msg struct {
			Type        string          `json:"type"`
			BlockNumber uint64          `json:"block_number"`
			Data        json.RawMessage `json:"data"`
			Message     string          `json:"message"`
		}
		if err := json.Unmarshal(line, &msg); err != nil {
			return fmt.Errorf("unmarshal failed: %w", err)
		}

		switch msg.Type {
		case "block":
			if err := handler(msg.BlockNumber, msg.Data); err != nil {
				return err
			}
		case "status":
			// At tip, continue
			continue
		case "error":
			return fmt.Errorf("server error: %s", msg.Message)
		}
	}
}
