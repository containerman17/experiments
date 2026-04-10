package main

import (
	"bytes"
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

	"block_fetcher/store"

	"github.com/erigontech/mdbx-go/mdbx"
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
	req := jsonRPCRequest{
		JSONRPC: "2.0",
		ID:      1,
		Method:  method,
		Params:  params,
	}
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
		return nil, fmt.Errorf("unmarshal response: %w (body: %s)", err, string(respBody))
	}
	if rpcResp.Error != nil {
		return nil, fmt.Errorf("rpc error %d: %s", rpcResp.Error.Code, rpcResp.Error.Message)
	}
	return rpcResp.Result, nil
}

func ethGetBalance(addr string, block uint64) (*big.Int, error) {
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

func ethGetStorageAt(addr, slot string, block uint64) ([32]byte, error) {
	blockHex := fmt.Sprintf("0x%x", block)
	result, err := rpcCall("eth_getStorageAt", []interface{}{addr, slot, blockHex})
	if err != nil {
		return [32]byte{}, err
	}
	var hexStr string
	if err := json.Unmarshal(result, &hexStr); err != nil {
		return [32]byte{}, err
	}
	val := new(big.Int)
	val.SetString(hexStr[2:], 16)
	var out [32]byte
	val.FillBytes(out[:])
	return out, nil
}

func ethGetNonce(addr string, block uint64) (uint64, error) {
	blockHex := fmt.Sprintf("0x%x", block)
	result, err := rpcCall("eth_getTransactionCount", []interface{}{addr, blockHex})
	if err != nil {
		return 0, err
	}
	var hexStr string
	if err := json.Unmarshal(result, &hexStr); err != nil {
		return 0, err
	}
	val := new(big.Int)
	val.SetString(hexStr[2:], 16)
	return val.Uint64(), nil
}

func hexToAddr(s string) [20]byte {
	var addr [20]byte
	b, _ := hex.DecodeString(s[2:]) // strip 0x
	copy(addr[:], b)
	return addr
}

func hexToSlot(s string) [32]byte {
	var slot [32]byte
	s = s[2:] // strip 0x
	// Pad to even length
	if len(s)%2 != 0 {
		s = "0" + s
	}
	b, _ := hex.DecodeString(s)
	// right-align
	copy(slot[32-len(b):], b)
	return slot
}

type balanceTest struct {
	Name string
	Addr string
}

type storageTest struct {
	Name     string
	Contract string
	Slot     string
}

func main() {
	dbDir := flag.String("db", "data/mainnet-mdbx", "MDBX database directory")
	flag.Parse()

	db, err := store.Open(*dbDir)
	if err != nil {
		log.Fatalf("Failed to open database: %v", err)
	}
	defer db.Close()

	// Check head block
	roTx, err := db.BeginRO()
	if err != nil {
		log.Fatalf("BeginRO: %v", err)
	}
	head, ok := store.GetHeadBlock(roTx, db)
	roTx.Abort()
	if !ok {
		log.Fatal("No head block in database")
	}
	fmt.Printf("Head block: %d\n", head)

	// Test blocks
	testBlocks := []uint64{1, 100, 500, 800, 1000}
	var validBlocks []uint64
	for _, b := range testBlocks {
		if b <= head {
			validBlocks = append(validBlocks, b)
		}
	}
	fmt.Printf("Testing at blocks: %v\n\n", validBlocks)

	// Test addresses for balance checks
	balanceTests := []balanceTest{
		{"Blackhole (fee sink)", "0x0100000000000000000000000000000000000000"},
		{"WAVAX contract", "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7"},
	}

	// Collect some sender addresses from AccountState for additional testing
	roTx, err = db.BeginRO()
	if err != nil {
		log.Fatalf("BeginRO: %v", err)
	}
	func() {
		cursor, err := roTx.OpenCursor(db.AccountState)
		if err != nil {
			log.Fatalf("OpenCursor: %v", err)
		}
		defer cursor.Close()

		count := 0
		k, _, err := cursor.Get(nil, nil, mdbx.First)
		for err == nil && count < 5 {
			if len(k) == 20 {
				addr := fmt.Sprintf("0x%x", k)
				balanceTests = append(balanceTests, balanceTest{
					Name: fmt.Sprintf("Account from state #%d", count),
					Addr: addr,
				})
				count++
			}
			k, _, err = cursor.Get(nil, nil, mdbx.Next)
		}
	}()
	roTx.Abort()

	// Storage tests — WAVAX contract slots
	// Slot 0 is typically used for name/symbol in Solidity, but WAVAX might use different layout.
	// Let's check some common ERC-20 slots.
	storageTests := []storageTest{
		{"WAVAX slot 0", "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7", "0x0"},
		{"WAVAX slot 1", "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7", "0x1"},
		{"WAVAX slot 2", "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7", "0x2"},
		{"WAVAX slot 3", "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7", "0x3"},
	}

	var checked, matched, mismatched, errors int

	// --- Balance tests ---
	fmt.Println("=== BALANCE TESTS ===")
	for _, bt := range balanceTests {
		fmt.Printf("\n%s (%s)\n", bt.Name, bt.Addr)
		addr := hexToAddr(bt.Addr)

		for _, blockNum := range validBlocks {
			roTx, err = db.BeginRO()
			if err != nil {
				log.Fatalf("BeginRO: %v", err)
			}
			localAcct, err := store.LookupHistoricalAccount(roTx, db, addr, blockNum)
			roTx.Abort()
			if err != nil {
				fmt.Printf("  block %5d: LOCAL ERROR: %v\n", blockNum, err)
				errors++
				continue
			}

			localBalance := new(big.Int)
			if localAcct != nil {
				localBalance.SetBytes(localAcct.Balance[:])
			}

			remoteBalance, err := ethGetBalance(bt.Addr, blockNum)
			if err != nil {
				fmt.Printf("  block %5d: RPC ERROR: %v\n", blockNum, err)
				errors++
				continue
			}

			checked++
			if localBalance.Cmp(remoteBalance) == 0 {
				matched++
				fmt.Printf("  block %5d: OK  balance=%s\n", blockNum, localBalance.String())
			} else {
				mismatched++
				fmt.Printf("  block %5d: MISMATCH  local=%s  remote=%s\n",
					blockNum, localBalance.String(), remoteBalance.String())
			}
		}
	}

	// --- Nonce tests ---
	fmt.Println("\n=== NONCE TESTS ===")
	for _, bt := range balanceTests {
		fmt.Printf("\n%s (%s)\n", bt.Name, bt.Addr)
		addr := hexToAddr(bt.Addr)

		for _, blockNum := range validBlocks {
			roTx, err = db.BeginRO()
			if err != nil {
				log.Fatalf("BeginRO: %v", err)
			}
			localAcct, err := store.LookupHistoricalAccount(roTx, db, addr, blockNum)
			roTx.Abort()
			if err != nil {
				fmt.Printf("  block %5d: LOCAL ERROR: %v\n", blockNum, err)
				errors++
				continue
			}

			var localNonce uint64
			if localAcct != nil {
				localNonce = localAcct.Nonce
			}

			remoteNonce, err := ethGetNonce(bt.Addr, blockNum)
			if err != nil {
				fmt.Printf("  block %5d: RPC ERROR: %v\n", blockNum, err)
				errors++
				continue
			}

			checked++
			if localNonce == remoteNonce {
				matched++
				fmt.Printf("  block %5d: OK  nonce=%d\n", blockNum, localNonce)
			} else {
				mismatched++
				fmt.Printf("  block %5d: MISMATCH  local=%d  remote=%d\n",
					blockNum, localNonce, remoteNonce)
			}
		}
	}

	// --- Storage tests ---
	fmt.Println("\n=== STORAGE TESTS ===")
	for _, st := range storageTests {
		fmt.Printf("\n%s (%s slot %s)\n", st.Name, st.Contract, st.Slot)
		addr := hexToAddr(st.Contract)
		slot := hexToSlot(st.Slot)

		for _, blockNum := range validBlocks {
			roTx, err = db.BeginRO()
			if err != nil {
				log.Fatalf("BeginRO: %v", err)
			}
			localVal, err := store.LookupHistoricalStorage(roTx, db, addr, slot, blockNum)
			roTx.Abort()
			if err != nil {
				fmt.Printf("  block %5d: LOCAL ERROR: %v\n", blockNum, err)
				errors++
				continue
			}

			remoteVal, err := ethGetStorageAt(st.Contract, st.Slot, blockNum)
			if err != nil {
				fmt.Printf("  block %5d: RPC ERROR: %v\n", blockNum, err)
				errors++
				continue
			}

			checked++
			if localVal == remoteVal {
				matched++
				fmt.Printf("  block %5d: OK  value=0x%x\n", blockNum, localVal)
			} else {
				mismatched++
				fmt.Printf("  block %5d: MISMATCH  local=0x%x  remote=0x%x\n",
					blockNum, localVal, remoteVal)
			}
		}
	}

	// --- Summary ---
	fmt.Printf("\n=== SUMMARY ===\n")
	fmt.Printf("Checked:    %d\n", checked)
	fmt.Printf("Matched:    %d\n", matched)
	fmt.Printf("Mismatched: %d\n", mismatched)
	fmt.Printf("Errors:     %d\n", errors)

	if mismatched > 0 {
		os.Exit(1)
	}
	fmt.Println("\nAll checks passed!")
}
