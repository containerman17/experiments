package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"os"
	"runtime"
	"time"

	cparams "github.com/ava-labs/avalanchego/graft/coreth/params"
	ccustomtypes "github.com/ava-labs/avalanchego/graft/coreth/plugin/evm/customtypes"
	proposerblock "github.com/ava-labs/avalanchego/vms/proposervm/block"
	"github.com/ava-labs/libevm/core/types"
	"github.com/ava-labs/libevm/rlp"
	"github.com/erigontech/mdbx-go/mdbx"
	"github.com/joho/godotenv"

	"block_fetcher/store"
)

const blockNum = 19
const blockHex = "0x13"

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

var httpClient = &http.Client{Timeout: 60 * time.Second}

func rpcCall(url, method string, params []interface{}) (json.RawMessage, error) {
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

	resp, err := httpClient.Post(url, "application/json", bytes.NewReader(body))
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

func ethGetBalance(url string, addr string) (*big.Int, error) {
	result, err := rpcCall(url, "eth_getBalance", []interface{}{addr, blockHex})
	if err != nil {
		return nil, err
	}
	var hexStr string
	if err := json.Unmarshal(result, &hexStr); err != nil {
		return nil, err
	}
	val := new(big.Int)
	if len(hexStr) > 2 {
		val.SetString(hexStr[2:], 16)
	}
	return val, nil
}

func ethGetTransactionCount(url string, addr string) (uint64, error) {
	result, err := rpcCall(url, "eth_getTransactionCount", []interface{}{addr, blockHex})
	if err != nil {
		return 0, err
	}
	var hexStr string
	if err := json.Unmarshal(result, &hexStr); err != nil {
		return 0, err
	}
	val := new(big.Int)
	if len(hexStr) > 2 {
		val.SetString(hexStr[2:], 16)
	}
	return val.Uint64(), nil
}

func ethGetCode(url string, addr string) ([]byte, error) {
	result, err := rpcCall(url, "eth_getCode", []interface{}{addr, blockHex})
	if err != nil {
		return nil, err
	}
	var hexStr string
	if err := json.Unmarshal(result, &hexStr); err != nil {
		return nil, err
	}
	if hexStr == "0x" || hexStr == "" {
		return nil, nil
	}
	return hex.DecodeString(hexStr[2:])
}

func ethGetStorageAt(url string, addr, slot string) ([32]byte, error) {
	result, err := rpcCall(url, "eth_getStorageAt", []interface{}{addr, slot, blockHex})
	if err != nil {
		return [32]byte{}, err
	}
	var hexStr string
	if err := json.Unmarshal(result, &hexStr); err != nil {
		return [32]byte{}, err
	}
	val := new(big.Int)
	if len(hexStr) > 2 {
		val.SetString(hexStr[2:], 16)
	}
	var out [32]byte
	val.FillBytes(out[:])
	return out, nil
}

func debugTraceBlock(url string) {
	fmt.Println("\n=== debug_traceBlockByNumber ===")
	result, err := rpcCall(url, "debug_traceBlockByNumber", []interface{}{blockHex, map[string]interface{}{
		"tracer": "prestateTracer",
		"tracerConfig": map[string]interface{}{
			"diffMode": true,
		},
	}})
	if err != nil {
		fmt.Printf("debug_traceBlockByNumber error: %v\n", err)
		return
	}

	// Pretty-print the result
	var prettyJSON bytes.Buffer
	if err := json.Indent(&prettyJSON, result, "", "  "); err != nil {
		fmt.Printf("Raw result: %s\n", string(result))
		return
	}
	fmt.Println(prettyJSON.String())
}

func parseEthBlock(raw []byte) (*types.Block, error) {
	if blk, err := proposerblock.ParseWithoutVerification(raw); err == nil {
		ethBlock := new(types.Block)
		if err := rlp.DecodeBytes(blk.Block(), ethBlock); err != nil {
			return nil, fmt.Errorf("decode inner eth block: %w", err)
		}
		return ethBlock, nil
	}

	_, _, rest, err := rlp.Split(raw)
	if err != nil {
		return nil, fmt.Errorf("rlp split: %w", err)
	}
	rawBlock := raw[:len(raw)-len(rest)]

	ethBlock := new(types.Block)
	if err := rlp.DecodeBytes(rawBlock, ethBlock); err != nil {
		return nil, fmt.Errorf("decode pre-fork eth block: %w", err)
	}
	return ethBlock, nil
}

func main() {
	// Register coreth extras (must be done before any block parsing)
	cparams.RegisterExtras()
	ccustomtypes.Register()

	// Load .env
	godotenv.Load()
	rpcURL := os.Getenv("ARCHIVAL_RPC_URL")
	if rpcURL == "" {
		log.Fatal("ARCHIVAL_RPC_URL not set in environment or .env")
	}

	// MDBX requires OS thread locking
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	db, err := store.Open("chain.db")
	if err != nil {
		log.Fatalf("Failed to open database: %v", err)
	}
	defer db.Close()

	roTx, err := db.BeginRO()
	if err != nil {
		log.Fatalf("BeginRO: %v", err)
	}
	defer roTx.Abort()

	// === Parse block 19 ===
	fmt.Println("=== Block 19 Info ===")
	raw, err := store.GetBlockByNumber(roTx, db, blockNum)
	if err != nil {
		log.Fatalf("GetBlockByNumber: %v", err)
	}

	ethBlock, err := parseEthBlock(raw)
	if err != nil {
		log.Fatalf("parseEthBlock: %v", err)
	}

	header := ethBlock.Header()
	fmt.Printf("Block number: %d\n", header.Number.Uint64())
	fmt.Printf("State root:   %x\n", header.Root)
	fmt.Printf("Tx count:     %d\n", len(ethBlock.Transactions()))

	for i, tx := range ethBlock.Transactions() {
		from, _ := types.LatestSignerForChainID(tx.ChainId()).Sender(tx)
		fmt.Printf("  TX %d: from=%x to=%v value=%s gas=%d\n",
			i, from, tx.To(), tx.Value().String(), tx.Gas())
		if tx.To() == nil {
			fmt.Printf("         CONTRACT CREATION (input len=%d)\n", len(tx.Data()))
		}
	}

	// === List ALL accounts in our DB ===
	fmt.Println("\n=== All Accounts in DB ===")
	type accountEntry struct {
		addr [20]byte
		acct *store.Account
	}
	var accounts []accountEntry

	func() {
		cursor, err := roTx.OpenCursor(db.AccountState)
		if err != nil {
			log.Fatalf("OpenCursor AccountState: %v", err)
		}
		defer cursor.Close()

		k, v, err := cursor.Get(nil, nil, mdbx.First)
		for err == nil {
			if len(k) == 20 {
				var addr [20]byte
				copy(addr[:], k)
				acct := store.DecodeAccount(v)
				accounts = append(accounts, accountEntry{addr, acct})

				balance := new(big.Int).SetBytes(acct.Balance[:])
				hasCode := acct.CodeHash != store.EmptyCodeHash
				fmt.Printf("  %x  nonce=%d balance=%s hasCode=%v codeHash=%x\n",
					addr, acct.Nonce, balance.String(), hasCode, acct.CodeHash)
			}
			k, v, err = cursor.Get(nil, nil, mdbx.Next)
		}
		if err != nil && !mdbx.IsNotFound(err) {
			log.Fatalf("Account cursor: %v", err)
		}
	}()
	fmt.Printf("Total accounts: %d\n", len(accounts))

	// === List ALL storage slots in our DB ===
	fmt.Println("\n=== All Storage Slots in DB ===")
	type storageEntry struct {
		addr  [20]byte
		slot  [32]byte
		value [32]byte
	}
	var storageSlots []storageEntry

	func() {
		cursor, err := roTx.OpenCursor(db.StorageState)
		if err != nil {
			log.Fatalf("OpenCursor StorageState: %v", err)
		}
		defer cursor.Close()

		k, v, err := cursor.Get(nil, nil, mdbx.First)
		for err == nil {
			if len(k) == 52 {
				var addr [20]byte
				var slot [32]byte
				copy(addr[:], k[:20])
				copy(slot[:], k[20:])
				// Pad value back to 32 bytes (stored stripped of leading zeros)
				var value [32]byte
				copy(value[32-len(v):], v)
				storageSlots = append(storageSlots, storageEntry{addr, slot, value})

				fmt.Printf("  addr=%x slot=%x value=%x\n", addr, slot, value)
			}
			k, v, err = cursor.Get(nil, nil, mdbx.Next)
		}
		if err != nil && !mdbx.IsNotFound(err) {
			log.Fatalf("Storage cursor: %v", err)
		}
	}()
	fmt.Printf("Total storage slots: %d\n", len(storageSlots))

	// Done with DB reads
	roTx.Abort()
	runtime.UnlockOSThread()

	// === Compare accounts against archival RPC ===
	fmt.Println("\n=== Account Comparison (local vs RPC at block 19) ===")
	for _, ae := range accounts {
		addrHex := fmt.Sprintf("0x%x", ae.addr)

		localBalance := new(big.Int).SetBytes(ae.acct.Balance[:])
		remoteBalance, err := ethGetBalance(rpcURL, addrHex)
		if err != nil {
			fmt.Printf("  %s: RPC balance error: %v\n", addrHex, err)
			continue
		}

		remoteNonce, err := ethGetTransactionCount(rpcURL, addrHex)
		if err != nil {
			fmt.Printf("  %s: RPC nonce error: %v\n", addrHex, err)
			continue
		}

		remoteCode, err := ethGetCode(rpcURL, addrHex)
		if err != nil {
			fmt.Printf("  %s: RPC code error: %v\n", addrHex, err)
			continue
		}

		balMatch := localBalance.Cmp(remoteBalance) == 0
		nonceMatch := ae.acct.Nonce == remoteNonce
		hasLocalCode := ae.acct.CodeHash != store.EmptyCodeHash
		hasRemoteCode := len(remoteCode) > 0

		if balMatch && nonceMatch && hasLocalCode == hasRemoteCode {
			fmt.Printf("  %s: OK (nonce=%d balance=%s hasCode=%v)\n",
				addrHex, ae.acct.Nonce, localBalance.String(), hasLocalCode)
		} else {
			fmt.Printf("  %s: MISMATCH!\n", addrHex)
			if !balMatch {
				fmt.Printf("    balance: local=%s remote=%s\n", localBalance.String(), remoteBalance.String())
			}
			if !nonceMatch {
				fmt.Printf("    nonce: local=%d remote=%d\n", ae.acct.Nonce, remoteNonce)
			}
			if hasLocalCode != hasRemoteCode {
				fmt.Printf("    code: local_has=%v (hash=%x) remote_has=%v (len=%d)\n",
					hasLocalCode, ae.acct.CodeHash, hasRemoteCode, len(remoteCode))
			}
		}
	}

	// === Compare storage slots against archival RPC ===
	fmt.Println("\n=== Storage Comparison (local vs RPC at block 19) ===")
	for _, se := range storageSlots {
		addrHex := fmt.Sprintf("0x%x", se.addr)
		slotHex := fmt.Sprintf("0x%x", se.slot)

		remoteValue, err := ethGetStorageAt(rpcURL, addrHex, slotHex)
		if err != nil {
			fmt.Printf("  %s slot %s: RPC error: %v\n", addrHex, slotHex, err)
			continue
		}

		if se.value == remoteValue {
			fmt.Printf("  %s slot %s: OK (value=%x)\n", addrHex, slotHex, se.value)
		} else {
			fmt.Printf("  %s slot %s: MISMATCH!\n", addrHex, slotHex)
			fmt.Printf("    local:  %x\n", se.value)
			fmt.Printf("    remote: %x\n", remoteValue)
		}
	}

	// === debug_traceBlockByNumber ===
	debugTraceBlock(rpcURL)
}
