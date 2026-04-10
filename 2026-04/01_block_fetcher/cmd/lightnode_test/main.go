package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"os"
	"time"

	"block_fetcher/lightnode"

	"github.com/ava-labs/libevm/common"
)

const rpcURL = "https://api.avax.network/ext/bc/C/rpc"

var httpClient = &http.Client{Timeout: 30 * time.Second}

// JSON-RPC helpers

type jsonRPCRequest struct {
	JSONRPC string        `json:"jsonrpc"`
	ID      int           `json:"id"`
	Method  string        `json:"method"`
	Params  []interface{} `json:"params"`
}

type jsonRPCResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int             `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func rpcCall(method string, params []interface{}) (json.RawMessage, error) {
	req := jsonRPCRequest{JSONRPC: "2.0", ID: 1, Method: method, Params: params}
	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	resp, err := httpClient.Post(rpcURL, "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var rpcResp jsonRPCResponse
	if err := json.Unmarshal(respBody, &rpcResp); err != nil {
		return nil, fmt.Errorf("unmarshal: %w (body: %s)", err, string(respBody))
	}
	if rpcResp.Error != nil {
		return nil, fmt.Errorf("rpc error %d: %s", rpcResp.Error.Code, rpcResp.Error.Message)
	}
	return rpcResp.Result, nil
}

func rpcGetBalance(addr string, block uint64) (*big.Int, error) {
	blockHex := fmt.Sprintf("0x%x", block)
	result, err := rpcCall("eth_getBalance", []interface{}{addr, blockHex})
	if err != nil {
		return nil, err
	}
	var hexStr string
	if err := json.Unmarshal(result, &hexStr); err != nil {
		return nil, err
	}
	val := new(big.Int)
	val.SetString(hexStr[2:], 16)
	return val, nil
}

func rpcGetStorageAt(addr, slot string, block uint64) ([]byte, error) {
	blockHex := fmt.Sprintf("0x%x", block)
	result, err := rpcCall("eth_getStorageAt", []interface{}{addr, slot, blockHex})
	if err != nil {
		return nil, err
	}
	var hexStr string
	if err := json.Unmarshal(result, &hexStr); err != nil {
		return nil, err
	}
	b, _ := hex.DecodeString(hexStr[2:])
	// Pad to 32 bytes.
	out := make([]byte, 32)
	copy(out[32-len(b):], b)
	return out, nil
}

func rpcEthCall(to, data string, block uint64) ([]byte, error) {
	blockHex := fmt.Sprintf("0x%x", block)
	callObj := map[string]string{
		"to":   to,
		"data": data,
	}
	result, err := rpcCall("eth_call", []interface{}{callObj, blockHex})
	if err != nil {
		return nil, err
	}
	var hexStr string
	if err := json.Unmarshal(result, &hexStr); err != nil {
		return nil, err
	}
	if len(hexStr) < 2 {
		return nil, nil
	}
	return hex.DecodeString(hexStr[2:])
}

func main() {
	dbDir := flag.String("db", "data/mainnet-mdbx", "MDBX database directory")
	flag.Parse()

	ctx := context.Background()

	node, err := lightnode.New(lightnode.Config{DataDir: *dbDir})
	if err != nil {
		log.Fatalf("Failed to create node: %v", err)
	}
	defer node.Close()

	head, err := node.BlockNumber(ctx)
	if err != nil {
		log.Fatalf("BlockNumber: %v", err)
	}
	fmt.Printf("Head block: %d\n\n", head)

	var checked, matched, mismatched, errors int

	blackhole := common.HexToAddress("0x0100000000000000000000000000000000000000")
	wavax := common.HexToAddress("0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7")

	// ─── Balance tests ────────────────────────────────────────────
	fmt.Println("=== BALANCE TESTS (blackhole) ===")
	for _, blockNum := range []uint64{100, 500, 1000} {
		if blockNum > head {
			continue
		}
		localBal, err := node.BalanceAt(ctx, blackhole, big.NewInt(int64(blockNum)))
		if err != nil {
			fmt.Printf("  block %5d: LOCAL ERROR: %v\n", blockNum, err)
			errors++
			continue
		}
		remoteBal, err := rpcGetBalance(blackhole.Hex(), blockNum)
		if err != nil {
			fmt.Printf("  block %5d: RPC ERROR: %v\n", blockNum, err)
			errors++
			continue
		}
		checked++
		if localBal.Cmp(remoteBal) == 0 {
			matched++
			fmt.Printf("  block %5d: OK  balance=%s\n", blockNum, localBal.String())
		} else {
			mismatched++
			fmt.Printf("  block %5d: MISMATCH  local=%s  remote=%s\n", blockNum, localBal.String(), remoteBal.String())
		}
	}

	// ─── Storage tests (WAVAX slots) ──────────────────────────────
	fmt.Println("\n=== STORAGE TESTS (WAVAX at block 1000) ===")
	if head >= 1000 {
		slots := []string{"0x0", "0x1", "0x2", "0x3"}
		for _, slotStr := range slots {
			slot := common.HexToHash(slotStr)
			localVal, err := node.StorageAt(ctx, wavax, slot, big.NewInt(1000))
			if err != nil {
				fmt.Printf("  slot %s: LOCAL ERROR: %v\n", slotStr, err)
				errors++
				continue
			}
			remoteVal, err := rpcGetStorageAt(wavax.Hex(), slotStr, 1000)
			if err != nil {
				fmt.Printf("  slot %s: RPC ERROR: %v\n", slotStr, err)
				errors++
				continue
			}
			checked++
			if bytes.Equal(localVal, remoteVal) {
				matched++
				fmt.Printf("  slot %s: OK  value=0x%x\n", slotStr, localVal)
			} else {
				mismatched++
				fmt.Printf("  slot %s: MISMATCH\n    local =0x%x\n    remote=0x%x\n", slotStr, localVal, remoteVal)
			}
		}
	}

	// ─── CallContract test (WAVAX name()) ─────────────────────────
	fmt.Println("\n=== CALLCONTRACT TEST (WAVAX name() at block 1000) ===")
	if head >= 1000 {
		// name() selector = 0x06fdde03
		nameSelector, _ := hex.DecodeString("06fdde03")
		wavaxAddr := wavax
		localResult, err := node.CallContract(ctx, lightnode.CallMsg{
			To:   &wavaxAddr,
			Data: nameSelector,
		}, big.NewInt(1000))
		if err != nil {
			fmt.Printf("  LOCAL ERROR: %v\n", err)
			errors++
		} else {
			remoteResult, err := rpcEthCall(wavax.Hex(), "0x06fdde03", 1000)
			if err != nil {
				fmt.Printf("  RPC ERROR: %v\n", err)
				errors++
			} else {
				checked++
				if bytes.Equal(localResult, remoteResult) {
					matched++
					// Try to decode the string from ABI encoding.
					name := decodeABIString(localResult)
					fmt.Printf("  OK  name=%q  raw=0x%x\n", name, localResult)
				} else {
					mismatched++
					fmt.Printf("  MISMATCH\n    local =0x%x\n    remote=0x%x\n", localResult, remoteResult)
				}
			}
		}

		// symbol() = 0x95d89b41
		fmt.Println("\n=== CALLCONTRACT TEST (WAVAX symbol() at block 1000) ===")
		symbolSelector, _ := hex.DecodeString("95d89b41")
		localResult, err = node.CallContract(ctx, lightnode.CallMsg{
			To:   &wavaxAddr,
			Data: symbolSelector,
		}, big.NewInt(1000))
		if err != nil {
			fmt.Printf("  LOCAL ERROR: %v\n", err)
			errors++
		} else {
			remoteResult, err := rpcEthCall(wavax.Hex(), "0x95d89b41", 1000)
			if err != nil {
				fmt.Printf("  RPC ERROR: %v\n", err)
				errors++
			} else {
				checked++
				if bytes.Equal(localResult, remoteResult) {
					matched++
					symbol := decodeABIString(localResult)
					fmt.Printf("  OK  symbol=%q  raw=0x%x\n", symbol, localResult)
				} else {
					mismatched++
					fmt.Printf("  MISMATCH\n    local =0x%x\n    remote=0x%x\n", localResult, remoteResult)
				}
			}
		}

		// decimals() = 0x313ce567
		fmt.Println("\n=== CALLCONTRACT TEST (WAVAX decimals() at block 1000) ===")
		decimalsSelector, _ := hex.DecodeString("313ce567")
		localResult, err = node.CallContract(ctx, lightnode.CallMsg{
			To:   &wavaxAddr,
			Data: decimalsSelector,
		}, big.NewInt(1000))
		if err != nil {
			fmt.Printf("  LOCAL ERROR: %v\n", err)
			errors++
		} else {
			remoteResult, err := rpcEthCall(wavax.Hex(), "0x313ce567", 1000)
			if err != nil {
				fmt.Printf("  RPC ERROR: %v\n", err)
				errors++
			} else {
				checked++
				if bytes.Equal(localResult, remoteResult) {
					matched++
					decimals := new(big.Int).SetBytes(localResult)
					fmt.Printf("  OK  decimals=%s\n", decimals.String())
				} else {
					mismatched++
					fmt.Printf("  MISMATCH\n    local =0x%x\n    remote=0x%x\n", localResult, remoteResult)
				}
			}
		}
	}

	// ─── Summary ──────────────────────────────────────────────────
	fmt.Printf("\n=== SUMMARY ===\n")
	fmt.Printf("Checked:    %d\n", checked)
	fmt.Printf("Matched:    %d\n", matched)
	fmt.Printf("Mismatched: %d\n", mismatched)
	fmt.Printf("Errors:     %d\n", errors)

	if mismatched > 0 || errors > 0 {
		os.Exit(1)
	}
	fmt.Println("\nAll checks passed!")
}

// decodeABIString attempts to decode an ABI-encoded string return value.
func decodeABIString(data []byte) string {
	if len(data) < 64 {
		return ""
	}
	// First 32 bytes = offset, next 32 bytes = length
	offset := new(big.Int).SetBytes(data[:32]).Uint64()
	if offset+32 > uint64(len(data)) {
		return ""
	}
	length := new(big.Int).SetBytes(data[offset : offset+32]).Uint64()
	start := offset + 32
	if start+length > uint64(len(data)) {
		return ""
	}
	return string(data[start : start+length])
}
