package api

import (
	"bufio"
	"context"
	"encoding/json"
	"evm-sink/storage"
	"fmt"
	"log"
	"net"
	"sync"
	"time"
)

type Server struct {
	listener net.Listener
	storage  *storage.Storage
	s3       *storage.S3Client
	s3Prefix string
	chains   map[uint64]*ChainState
	mu       sync.RWMutex
	ctx      context.Context
	cancel   context.CancelFunc
	wg       sync.WaitGroup
}

type ChainState struct {
	ChainID     uint64
	Name        string
	LatestBlock uint64
	mu          sync.RWMutex
	waiters     []chan struct{}
}

// ClientMessage from client (greeting or command)
type ClientMessage struct {
	Type      string `json:"type,omitempty"` // "list_chains" or empty for greeting
	ChainID   uint64 `json:"chain_id,omitempty"`
	FromBlock uint64 `json:"from_block,omitempty"`
}

// ChainInfo for list_chains response
type ChainInfo struct {
	ChainID     uint64 `json:"chain_id"`
	Name        string `json:"name"`
	LatestBlock uint64 `json:"latest_block"`
}

// ChainsResponse sent to client
type ChainsResponse struct {
	Type   string      `json:"type"`
	Chains []ChainInfo `json:"chains"`
}

// BlockMessage sent to client
type BlockMessage struct {
	Type        string          `json:"type"`
	ChainID     uint64          `json:"chain_id"`
	BlockNumber uint64          `json:"block_number"`
	Data        json.RawMessage `json:"data"`
}

// StatusMessage sent to client
type StatusMessage struct {
	Type      string `json:"type"`
	Status    string `json:"status"`
	HeadBlock uint64 `json:"head_block"`
}

// ErrorMessage sent to client
type ErrorMessage struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

func NewServer(store *storage.Storage, s3 *storage.S3Client, s3Prefix string) *Server {
	ctx, cancel := context.WithCancel(context.Background())
	return &Server{
		storage:  store,
		s3:       s3,
		s3Prefix: s3Prefix,
		chains:   make(map[uint64]*ChainState),
		ctx:      ctx,
		cancel:   cancel,
	}
}

// RegisterChain registers a chain for serving
func (s *Server) RegisterChain(chainID uint64, name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.chains[chainID] = &ChainState{ChainID: chainID, Name: name}
}

// GetChains returns info about all registered chains
func (s *Server) GetChains() []ChainInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()

	chains := make([]ChainInfo, 0, len(s.chains))
	for _, state := range s.chains {
		state.mu.RLock()
		chains = append(chains, ChainInfo{
			ChainID:     state.ChainID,
			Name:        state.Name,
			LatestBlock: state.LatestBlock,
		})
		state.mu.RUnlock()
	}
	return chains
}

// UpdateLatestBlock updates the latest known block for a chain and notifies waiters
func (s *Server) UpdateLatestBlock(chainID, blockNum uint64) {
	s.mu.RLock()
	state, ok := s.chains[chainID]
	s.mu.RUnlock()
	if !ok {
		return
	}

	state.mu.Lock()
	if blockNum > state.LatestBlock {
		state.LatestBlock = blockNum
		for _, ch := range state.waiters {
			select {
			case ch <- struct{}{}:
			default:
			}
		}
		state.waiters = nil
	}
	state.mu.Unlock()
}

// GetLatestBlock returns the latest known block for a chain
func (s *Server) GetLatestBlock(chainID uint64) uint64 {
	s.mu.RLock()
	state, ok := s.chains[chainID]
	s.mu.RUnlock()
	if !ok {
		return 0
	}

	state.mu.RLock()
	defer state.mu.RUnlock()
	return state.LatestBlock
}

func (s *Server) Start(addr string) error {
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("failed to listen: %w", err)
	}
	s.listener = listener

	s.wg.Add(1)
	go s.acceptLoop()

	log.Printf("[Server] Listening on %s", addr)
	return nil
}

func (s *Server) Stop() {
	s.cancel()
	if s.listener != nil {
		s.listener.Close()
	}
	s.wg.Wait()
}

func (s *Server) acceptLoop() {
	defer s.wg.Done()

	for {
		conn, err := s.listener.Accept()
		if err != nil {
			select {
			case <-s.ctx.Done():
				return
			default:
				log.Printf("[Server] Accept error: %v", err)
				continue
			}
		}

		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.handleClient(conn)
		}()
	}
}

func (s *Server) handleClient(conn net.Conn) {
	defer conn.Close()

	conn.SetReadDeadline(time.Now().Add(30 * time.Second))

	reader := bufio.NewReader(conn)
	line, err := reader.ReadBytes('\n')
	if err != nil {
		s.sendError(conn, "failed to read message")
		return
	}

	var msg ClientMessage
	if err := json.Unmarshal(line, &msg); err != nil {
		s.sendError(conn, "invalid message format")
		return
	}

	if msg.Type == "list_chains" {
		s.sendChains(conn)
		return
	}

	s.mu.RLock()
	_, ok := s.chains[msg.ChainID]
	s.mu.RUnlock()
	if !ok {
		s.sendError(conn, fmt.Sprintf("unknown chain %d", msg.ChainID))
		return
	}

	conn.SetReadDeadline(time.Time{})

	fromBlock := msg.FromBlock
	if fromBlock == 0 {
		fromBlock = 1
	}

	log.Printf("[Server] Client connected for chain %d from block %d", msg.ChainID, fromBlock)

	if err := s.streamBlocks(conn, msg.ChainID, fromBlock); err != nil {
		log.Printf("[Server] Client stream ended: %v", err)
	}
}

func (s *Server) sendChains(conn net.Conn) {
	resp := ChainsResponse{
		Type:   "chains",
		Chains: s.GetChains(),
	}
	data, _ := json.Marshal(resp)
	conn.Write(append(data, '\n'))
}

// streamBlocks streams blocks directly from PebbleDB, falling back to S3 for old data
func (s *Server) streamBlocks(conn net.Conn, chainID, fromBlock uint64) error {
	ctx := s.ctx
	currentBlock := fromBlock
	sentLiveStatus := false

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		// Try PebbleDB first
		data, err := s.storage.GetBlock(chainID, currentBlock)
		if err == nil {
			if err := s.sendBlock(conn, chainID, currentBlock, data); err != nil {
				return err
			}
			currentBlock++
			sentLiveStatus = false
			continue
		}

		// Not in PebbleDB - try S3
		batchStart := storage.BatchStart(currentBlock)
		batchEnd := storage.BatchEnd(batchStart)
		key := storage.S3Key(s.s3Prefix, chainID, batchStart, batchEnd)

		blocks, err := s.s3.Download(ctx, key)
		if err == nil && len(blocks) > 0 {
			// Send all blocks from this batch starting from currentBlock
			offset := int(currentBlock - batchStart)
			for i := offset; i < len(blocks); i++ {
				blockNum := batchStart + uint64(i)
				if err := s.sendBlock(conn, chainID, blockNum, blocks[i]); err != nil {
					return err
				}
			}
			currentBlock = batchStart + uint64(len(blocks))
			sentLiveStatus = false
			continue
		}

		// Block not available anywhere - we're at the tip, wait
		if !sentLiveStatus {
			s.sendStatus(conn, "live", currentBlock-1)
			sentLiveStatus = true
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func (s *Server) sendBlock(conn net.Conn, chainID, blockNum uint64, data []byte) error {
	msg := BlockMessage{
		Type:        "block",
		ChainID:     chainID,
		BlockNumber: blockNum,
		Data:        json.RawMessage(data),
	}

	encoded, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("failed to marshal block %d: %w", blockNum, err)
	}

	if _, err := conn.Write(append(encoded, '\n')); err != nil {
		return err
	}

	return nil
}

func (s *Server) sendError(conn net.Conn, message string) {
	msg := ErrorMessage{Type: "error", Message: message}
	data, _ := json.Marshal(msg)
	conn.Write(append(data, '\n'))
}

func (s *Server) sendStatus(conn net.Conn, status string, headBlock uint64) {
	msg := StatusMessage{Type: "status", Status: status, HeadBlock: headBlock}
	data, _ := json.Marshal(msg)
	conn.Write(append(data, '\n'))
}
