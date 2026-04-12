// Package rpc implements a JSON-RPC 2.0 server for Ethereum methods,
// backed by our MDBX flat state + log storage.
package rpc

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
)

// Request is a JSON-RPC 2.0 request.
type Request struct {
	JSONRPC string            `json:"jsonrpc"`
	Method  string            `json:"method"`
	Params  []json.RawMessage `json:"params"`
	ID      json.RawMessage   `json:"id"`
}

// Response is a JSON-RPC 2.0 response.
type Response struct {
	JSONRPC string          `json:"jsonrpc"`
	Result  any             `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
	ID      json.RawMessage `json:"id"`
}

// RPCError is a JSON-RPC 2.0 error.
type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// Server is the JSON-RPC server.
type Server struct {
	backend *Backend
	mux     *http.ServeMux
}

// NewServer creates a new RPC server backed by the given backend.
func NewServer(backend *Backend) *Server {
	s := &Server{backend: backend}
	s.mux = http.NewServeMux()
	// Match avalanchego's C-Chain RPC path.
	s.mux.HandleFunc("/ext/bc/C/rpc", s.handleRPC)
	// Also serve on root for convenience.
	s.mux.HandleFunc("/", s.handleRPC)
	return s
}

// ListenAndServe starts the HTTP server.
func (s *Server) ListenAndServe(addr string) error {
	log.Printf("RPC server listening on %s", addr)
	return http.ListenAndServe(addr, s.mux)
}

func (s *Server) handleRPC(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 10*1024*1024))
	if err != nil {
		http.Error(w, "read error", http.StatusBadRequest)
		return
	}

	// Try batch request first.
	var batch []Request
	if err := json.Unmarshal(body, &batch); err == nil && len(batch) > 0 {
		responses := make([]Response, len(batch))
		for i, req := range batch {
			responses[i] = s.dispatch(req)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(responses)
		return
	}

	// Single request.
	var req Request
	if err := json.Unmarshal(body, &req); err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Response{
			JSONRPC: "2.0",
			Error:   &RPCError{Code: -32700, Message: "parse error"},
			ID:      nil,
		})
		return
	}

	resp := s.dispatch(req)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func (s *Server) dispatch(req Request) Response {
	var result any
	var err error

	switch req.Method {
	case "eth_blockNumber":
		result, err = s.backend.BlockNumber()
	case "eth_chainId":
		result = "0xa86a" // 43114 = Avalanche C-Chain mainnet
	case "net_version":
		result = "43114"
	case "web3_clientVersion":
		result = "block_fetcher/0.1.0"
	case "eth_getBlockByNumber":
		result, err = s.backend.GetBlockByNumber(req.Params)
	case "eth_getBlockByHash":
		result, err = s.backend.GetBlockByHash(req.Params)
	case "eth_getTransactionByHash":
		result, err = s.backend.GetTransactionByHash(req.Params)
	case "eth_getTransactionReceipt":
		result, err = s.backend.GetTransactionReceipt(req.Params)
	case "eth_getBalance":
		result, err = s.backend.GetBalance(req.Params)
	case "eth_getStorageAt":
		result, err = s.backend.GetStorageAt(req.Params)
	case "eth_getCode":
		result, err = s.backend.GetCode(req.Params)
	case "eth_getTransactionCount":
		result, err = s.backend.GetTransactionCount(req.Params)
	case "eth_getLogs":
		result, err = s.backend.GetLogs(req.Params)
	case "eth_call":
		result, err = s.backend.Call(req.Params)
	case "eth_estimateGas":
		result, err = s.backend.EstimateGas(req.Params)
	case "eth_gasPrice":
		result, err = s.backend.GasPrice()
	case "eth_feeHistory":
		result, err = s.backend.FeeHistory(req.Params)
	default:
		return Response{
			JSONRPC: "2.0",
			Error:   &RPCError{Code: -32601, Message: fmt.Sprintf("method %s not found", req.Method)},
			ID:      req.ID,
		}
	}

	if err != nil {
		return Response{
			JSONRPC: "2.0",
			Error:   &RPCError{Code: -32000, Message: err.Error()},
			ID:      req.ID,
		}
	}

	return Response{
		JSONRPC: "2.0",
		Result:  result,
		ID:      req.ID,
	}
}
