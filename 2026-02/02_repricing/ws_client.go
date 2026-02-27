package main

import (
	"encoding/json"
	"fmt"
	"strconv"
	"sync"
	"sync/atomic"

	"github.com/gorilla/websocket"
)

type wsClient struct {
	conn  *websocket.Conn
	mu    sync.Mutex
	reqID atomic.Uint64
}

type wsPool struct {
	conns []*wsClient
	next  atomic.Uint64
}

type wsRPCRequest struct {
	JSONRPC string        `json:"jsonrpc"`
	ID      uint64        `json:"id"`
	Method  string        `json:"method"`
	Params  []interface{} `json:"params"`
}

type wsRPCResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   json.RawMessage `json:"error"`
}

func newWSClient(wsURL string) (*wsClient, error) {
	c, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		return nil, err
	}
	return &wsClient{conn: c}, nil
}

func newWSPool(wsURL string, size int) (*wsPool, error) {
	if size <= 0 {
		return nil, fmt.Errorf("ws pool size must be > 0")
	}
	p := &wsPool{conns: make([]*wsClient, 0, size)}
	for i := 0; i < size; i++ {
		c, err := newWSClient(wsURL)
		if err != nil {
			return nil, fmt.Errorf("dial ws conn %d/%d: %w", i+1, size, err)
		}
		p.conns = append(p.conns, c)
	}
	return p, nil
}

func (p *wsPool) callRaw(method string, params ...interface{}) (json.RawMessage, error) {
	idx := int((p.next.Add(1) - 1) % uint64(len(p.conns)))
	return p.conns[idx].callRaw(method, params...)
}

// callRaw is blocking by design: one in-flight request on the websocket.
func (c *wsClient) callRaw(method string, params ...interface{}) (json.RawMessage, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	id := c.reqID.Add(1)
	req := wsRPCRequest{
		JSONRPC: "2.0",
		ID:      id,
		Method:  method,
		Params:  params,
	}
	if err := c.conn.WriteJSON(req); err != nil {
		return nil, fmt.Errorf("ws write %s: %w", method, err)
	}

	for {
		_, msg, err := c.conn.ReadMessage()
		if err != nil {
			return nil, fmt.Errorf("ws read %s: %w", method, err)
		}
		var resp wsRPCResponse
		if err := json.Unmarshal(msg, &resp); err != nil {
			return nil, fmt.Errorf("ws unmarshal %s: %w", method, err)
		}
		if !rpcResponseIDMatches(resp.ID, id) {
			continue
		}
		if string(resp.Error) != "" && string(resp.Error) != "null" {
			return nil, fmt.Errorf("rpc error: %s", string(resp.Error))
		}
		if resp.Result == nil {
			return json.RawMessage("null"), nil
		}
		return resp.Result, nil
	}
}

func rpcResponseIDMatches(rawID json.RawMessage, expected uint64) bool {
	var idNum uint64
	if err := json.Unmarshal(rawID, &idNum); err == nil {
		return idNum == expected
	}
	var idStr string
	if err := json.Unmarshal(rawID, &idStr); err == nil {
		return idStr == strconv.FormatUint(expected, 10)
	}
	return false
}
