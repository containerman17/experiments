package api

import (
	"context"
	"encoding/json"
	"evm-sink/consts"
	"evm-sink/storage"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/klauspost/compress/zstd"
)

type Server struct {
	httpServer *http.Server
	storage    *storage.Storage
	s3         *storage.S3Client
	s3Prefix   string
	chains     map[uint64]*ChainState
	mu         sync.RWMutex
	ctx        context.Context
	cancel     context.CancelFunc
	zstdEnc    *zstd.Encoder
}

type ChainState struct {
	ChainID     uint64
	Name        string
	LatestBlock uint64
	mu          sync.RWMutex
}

// ChainInfo for /chains response
type ChainInfo struct {
	ChainID     uint64 `json:"chain_id"`
	Name        string `json:"name"`
	LatestBlock uint64 `json:"latest_block"`
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 64 * 1024,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

func NewServer(store *storage.Storage, s3 *storage.S3Client, s3Prefix string) *Server {
	ctx, cancel := context.WithCancel(context.Background())
	enc, _ := zstd.NewWriter(nil, zstd.WithEncoderLevel(zstd.SpeedFastest))
	return &Server{
		storage:  store,
		s3:       s3,
		s3Prefix: s3Prefix,
		chains:   make(map[uint64]*ChainState),
		ctx:      ctx,
		cancel:   cancel,
		zstdEnc:  enc,
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

// UpdateLatestBlock updates the latest known block for a chain
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
	mux := http.NewServeMux()
	mux.HandleFunc("GET /chains", s.handleChains)
	mux.HandleFunc("GET /ws", s.handleWS)

	s.httpServer = &http.Server{
		Addr:    addr,
		Handler: mux,
	}

	go func() {
		if err := s.httpServer.ListenAndServe(); err != http.ErrServerClosed {
			log.Printf("[Server] HTTP server error: %v", err)
		}
	}()

	log.Printf("[Server] Listening on %s", addr)
	return nil
}

func (s *Server) Stop() {
	s.cancel()
	if s.httpServer != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		s.httpServer.Shutdown(ctx)
	}
}

// handleChains responds with JSON list of available chains
func (s *Server) handleChains(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(s.GetChains())
}

// handleWS upgrades to WebSocket and streams blocks
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	chainIDStr := r.URL.Query().Get("chain")
	fromBlockStr := r.URL.Query().Get("from")

	if chainIDStr == "" {
		http.Error(w, "missing chain parameter", http.StatusBadRequest)
		return
	}

	chainID, err := strconv.ParseUint(chainIDStr, 10, 64)
	if err != nil {
		http.Error(w, "invalid chain parameter", http.StatusBadRequest)
		return
	}

	fromBlock := uint64(1)
	if fromBlockStr != "" {
		fromBlock, err = strconv.ParseUint(fromBlockStr, 10, 64)
		if err != nil {
			http.Error(w, "invalid from parameter", http.StatusBadRequest)
			return
		}
	}
	if fromBlock == 0 {
		fromBlock = 1
	}

	s.mu.RLock()
	_, ok := s.chains[chainID]
	s.mu.RUnlock()
	if !ok {
		http.Error(w, fmt.Sprintf("unknown chain %d", chainID), http.StatusNotFound)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[Server] WebSocket upgrade failed: %v", err)
		return
	}
	defer conn.Close()

	log.Printf("[Server] Client connected for chain %d from block %d", chainID, fromBlock)

	if err := s.streamBlocks(conn, chainID, fromBlock); err != nil {
		log.Printf("[Server] Client stream ended: %v", err)
	}
}

// s3RawResult holds prefetched S3 raw data
type s3RawResult struct {
	batchStart uint64
	data       []byte
	err        error
}

// streamBlocks streams blocks over WebSocket
// Binary frames only: zstd(NormalizedBlock\n...) - 1 to 100 blocks per frame
func (s *Server) streamBlocks(conn *websocket.Conn, chainID, fromBlock uint64) error {
	ctx := s.ctx
	currentBlock := fromBlock

	s3Lookahead := consts.ServerS3Lookahead

	// S3 prefetch cache: batchStart -> result channel
	s3Cache := make(map[uint64]chan s3RawResult)
	var s3CacheMu sync.Mutex

	// Helper to start S3 prefetch (raw, no decompression)
	prefetchS3 := func(batchStart uint64) {
		s3CacheMu.Lock()
		if _, exists := s3Cache[batchStart]; exists {
			s3CacheMu.Unlock()
			return
		}
		ch := make(chan s3RawResult, 1)
		s3Cache[batchStart] = ch
		s3CacheMu.Unlock()

		go func() {
			key := storage.S3Key(s.s3Prefix, chainID, batchStart, storage.BatchEnd(batchStart))
			data, err := s.s3.DownloadRaw(ctx, key)
			ch <- s3RawResult{batchStart: batchStart, data: data, err: err}
		}()
	}

	// Helper to get S3 batch (waits for prefetch if in progress)
	getS3Raw := func(batchStart uint64) ([]byte, error) {
		s3CacheMu.Lock()
		ch, exists := s3Cache[batchStart]
		s3CacheMu.Unlock()

		if !exists {
			// Not prefetched, fetch synchronously
			key := storage.S3Key(s.s3Prefix, chainID, batchStart, storage.BatchEnd(batchStart))
			return s.s3.DownloadRaw(ctx, key)
		}

		result := <-ch

		// Clean up cache
		s3CacheMu.Lock()
		delete(s3Cache, batchStart)
		s3CacheMu.Unlock()

		return result.data, result.err
	}

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		// Try PebbleDB first
		data, err := s.storage.GetBlock(chainID, currentBlock)
		if err == nil {
			// Compress single block with newline
			compressed := s.zstdEnc.EncodeAll(append(data, '\n'), nil)
			if err := conn.WriteMessage(websocket.BinaryMessage, compressed); err != nil {
				return err
			}
			currentBlock++
			continue
		}

		// Not in PebbleDB - use S3 with prefetching
		batchStart := storage.BatchStart(currentBlock)

		// Prefetch next batches
		for i := 0; i < s3Lookahead; i++ {
			prefetchBatch := batchStart + uint64(i)*storage.BatchSize
			prefetchS3(prefetchBatch)
		}

		rawData, err := getS3Raw(batchStart)
		if err == nil && len(rawData) > 0 {
			// Send raw S3 blob as-is (already zstd compressed JSONL)
			if err := conn.WriteMessage(websocket.BinaryMessage, rawData); err != nil {
				return err
			}
			currentBlock = batchStart + storage.BatchSize
			continue
		}

		// Block not available anywhere - we're at the tip, wait
		time.Sleep(consts.ServerTipPollInterval)
	}
}
