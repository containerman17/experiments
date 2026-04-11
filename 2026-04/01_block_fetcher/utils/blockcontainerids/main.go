package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/joho/godotenv"
)

const defaultOutputName = "container_ids.json"

type rpcRequest struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      int         `json:"id"`
	Method  string      `json:"method"`
	Params  interface{} `json:"params"`
}

type rpcResponse struct {
	Result json.RawMessage `json:"result"`
	Error  *rpcError       `json:"error"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type blockNumberResult string

type indexContainerResult struct {
	ID string `json:"id"`
}

func main() {
	_ = godotenv.Load()
	var (
		rpcURL = flag.String("rpc-url", strings.TrimSpace(os.Getenv("ARCHIVAL_RPC_URL")), "archival C-Chain RPC URL")
		out    = flag.String("out", filepath.Join("utils", "blockcontainerids", defaultOutputName), "output JSON path")
	)
	flag.Parse()

	if *rpcURL == "" {
		fatal(errors.New("rpc URL is required; set ARCHIVAL_RPC_URL or pass -rpc-url"))
	}

	indexURL, err := deriveIndexURL(*rpcURL)
	if err != nil {
		fatal(err)
	}

	client := &http.Client{Timeout: 30 * time.Second}
	ctx := context.Background()

	tip, err := fetchTip(ctx, client, *rpcURL)
	if err != nil {
		fatal(err)
	}

	targets := milestoneBlocks(tip)
	results := make(map[uint64]string, len(targets))
	for _, blockNum := range targets {
		containerID, err := fetchContainerID(ctx, client, indexURL, blockNum)
		if err != nil {
			fatal(fmt.Errorf("block %d: %w", blockNum, err))
		}
		results[blockNum] = containerID
		fmt.Printf("block=%d container_id=%s\n", blockNum, containerID)
	}

	if err := writeJSON(*out, results); err != nil {
		fatal(err)
	}

	fmt.Printf("wrote %d entries to %s\n", len(results), *out)
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}

func deriveIndexURL(rawRPCURL string) (string, error) {
	u, err := url.Parse(rawRPCURL)
	if err != nil {
		return "", fmt.Errorf("parse rpc url: %w", err)
	}

	switch {
	case strings.Contains(u.Path, "/ext/bc/C/rpc"):
		u.Path = strings.Replace(u.Path, "/ext/bc/C/rpc", "/ext/index/C/block", 1)
	case strings.Contains(u.Path, "/ext/C/rpc"):
		u.Path = strings.Replace(u.Path, "/ext/C/rpc", "/ext/index/C/block", 1)
	default:
		return "", fmt.Errorf("unsupported rpc path %q", u.Path)
	}
	return u.String(), nil
}

func fetchTip(ctx context.Context, client *http.Client, rpcURL string) (uint64, error) {
	var result blockNumberResult
	if err := callRPC(ctx, client, rpcURL, "eth_blockNumber", []interface{}{}, &result); err != nil {
		return 0, err
	}
	return parseHexUint64(string(result))
}

func fetchContainerID(ctx context.Context, client *http.Client, indexURL string, blockNum uint64) (string, error) {
	params := map[string]interface{}{
		"index":    strconv.FormatUint(blockNum, 10),
		"encoding": "hex",
	}
	var result indexContainerResult
	if err := callRPC(ctx, client, indexURL, "index.getContainerByIndex", params, &result); err != nil {
		return "", err
	}
	if result.ID == "" {
		return "", errors.New("empty container id")
	}
	return result.ID, nil
}

func callRPC(ctx context.Context, client *http.Client, endpoint, method string, params interface{}, out interface{}) error {
	body, err := json.Marshal(rpcRequest{
		JSONRPC: "2.0",
		ID:      1,
		Method:  method,
		Params:  params,
	})
	if err != nil {
		return fmt.Errorf("marshal %s request: %w", method, err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("create %s request: %w", method, err)
	}
	req.Header.Set("content-type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("%s request failed: %w", method, err)
	}
	defer resp.Body.Close()

	var rpcResp rpcResponse
	if err := json.NewDecoder(resp.Body).Decode(&rpcResp); err != nil {
		return fmt.Errorf("decode %s response: %w", method, err)
	}
	if rpcResp.Error != nil {
		return fmt.Errorf("%s rpc error %d: %s", method, rpcResp.Error.Code, rpcResp.Error.Message)
	}
	if err := json.Unmarshal(rpcResp.Result, out); err != nil {
		return fmt.Errorf("decode %s result: %w", method, err)
	}
	return nil
}

func parseHexUint64(s string) (uint64, error) {
	s = strings.TrimPrefix(strings.TrimSpace(s), "0x")
	if s == "" {
		return 0, errors.New("empty hex value")
	}
	return strconv.ParseUint(s, 16, 64)
}

func milestoneBlocks(tip uint64) []uint64 {
	blocks := make([]uint64, 0, tip/100_000+1)
	for block := uint64(100_000); block <= tip; block += 100_000 {
		blocks = append(blocks, block)
	}
	return blocks
}

func writeJSON(path string, entries map[uint64]string) error {
	keys := make([]uint64, 0, len(entries))
	for block := range entries {
		keys = append(keys, block)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", filepath.Dir(path), err)
	}

	var buf bytes.Buffer
	buf.WriteString("{\n")
	for i, block := range keys {
		fmt.Fprintf(&buf, "  %q: %q", strconv.FormatUint(block, 10), entries[block])
		if i < len(keys)-1 {
			buf.WriteString(",")
		}
		buf.WriteString("\n")
	}
	buf.WriteString("}\n")

	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}
