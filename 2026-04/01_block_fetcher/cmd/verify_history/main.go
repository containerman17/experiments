package main

import (
	"bytes"
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
	"github.com/joho/godotenv"
)

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

var httpClient = &http.Client{Timeout: 30 * time.Second}

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

func ethGetBalance(url string, addr string, block uint64) (*big.Int, error) {
	blockHex := fmt.Sprintf("0x%x", block)
	result, err := rpcCall(url, "eth_getBalance", []interface{}{addr, blockHex})
	if err != nil {
		return nil, err
	}
	var hexStr string
	if err := json.Unmarshal(result, &hexStr); err != nil {
		return nil, err
	}
	val := new(big.Int)
	val.SetString(hexStr[2:], 16) // strip 0x
	return val, nil
}

func ethGetStorageAt(url string, addr, slot string, block uint64) ([32]byte, error) {
	blockHex := fmt.Sprintf("0x%x", block)
	result, err := rpcCall(url, "eth_getStorageAt", []interface{}{addr, slot, blockHex})
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

// getHistoricalAccount retrieves the account state at a given block number.
// It uses the changeset/history index path:
//  1. Look up keyID for (addr, slot=0) which tracks account changes
//  2. Find the first block >= blockNum where this key changed via LookupHistoricalBlock
//  3. Read the changeset at that block to get the old value (= value at blockNum)
//  4. If no such block found, the current flat state is the value at blockNum
func getHistoricalAccount(tx *mdbx.Txn, db *store.DB, addr [20]byte, blockNum uint64) (*store.Account, error) {
	var zeroSlot [32]byte
	keyID, found, err := store.GetKeyID(tx, db, addr, zeroSlot)
	if err != nil {
		return nil, fmt.Errorf("GetKeyID: %w", err)
	}
	if !found {
		// Address never seen
		return nil, nil
	}

	// Find the next block >= blockNum where this key changed
	changeBlock, hasChange, err := store.LookupHistoricalBlock(tx, db, keyID, blockNum)
	if err != nil {
		return nil, fmt.Errorf("LookupHistoricalBlock: %w", err)
	}

	if !hasChange {
		// No change at or after blockNum => current flat state is the value
		return store.GetAccount(tx, db, addr)
	}

	// Read the changeset at changeBlock to get the old value
	changes, err := store.ReadChangeset(tx, db, changeBlock)
	if err != nil {
		return nil, fmt.Errorf("ReadChangeset at block %d: %w", changeBlock, err)
	}

	for _, c := range changes {
		if c.KeyID == keyID {
			if len(c.OldValue) == 0 {
				return nil, nil // account didn't exist
			}
			return store.DecodeAccount(c.OldValue), nil
		}
	}

	// keyID is in the history index but not in the changeset - shouldn't happen
	return nil, fmt.Errorf("keyID %d listed in history at block %d but not found in changeset", keyID, changeBlock)
}

func main() {
	dbDir := flag.String("db", "data/mdbx", "MDBX database directory")
	maxBlock := flag.Uint64("max-block", 1000, "Maximum block to test")
	checkInterval := flag.Uint64("interval", 100, "Check every N blocks")
	addrLimit := flag.Int("addr-limit", 20, "Maximum number of addresses to test")
	flag.Parse()

	// Load .env
	godotenv.Load()
	rpcURL := os.Getenv("ARCHIVAL_RPC_URL")
	if rpcURL == "" {
		log.Fatal("ARCHIVAL_RPC_URL not set in environment or .env")
	}

	// Open DB (read-only flags)
	db, err := store.Open(*dbDir)
	if err != nil {
		log.Fatalf("Failed to open database: %v", err)
	}
	defer db.Close()

	// Get head block
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

	endBlock := head
	if *maxBlock < endBlock {
		endBlock = *maxBlock
	}
	fmt.Printf("Testing blocks 1..%d (interval=%d)\n", endBlock, *checkInterval)

	// Scan AccountState to collect test addresses
	var addresses [][20]byte
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

		k, _, err := cursor.Get(nil, nil, mdbx.First)
		for err == nil && len(addresses) < *addrLimit {
			if len(k) == 20 {
				var addr [20]byte
				copy(addr[:], k)
				addresses = append(addresses, addr)
			}
			k, _, err = cursor.Get(nil, nil, mdbx.Next)
		}
		if err != nil && !mdbx.IsNotFound(err) {
			log.Fatalf("Cursor iteration: %v", err)
		}
	}()
	roTx.Abort()

	fmt.Printf("Testing %d addresses\n\n", len(addresses))

	var checked, matched, mismatched, errors int

	for _, addr := range addresses {
		addrHex := fmt.Sprintf("0x%x", addr)
		fmt.Printf("Address: %s\n", addrHex)

		for blockNum := uint64(1); blockNum <= endBlock; blockNum += *checkInterval {
			// Query local historical state
			roTx, err = db.BeginRO()
			if err != nil {
				log.Fatalf("BeginRO: %v", err)
			}
			localAcct, err := getHistoricalAccount(roTx, db, addr, blockNum)
			roTx.Abort()
			if err != nil {
				fmt.Printf("  block %d: LOCAL ERROR: %v\n", blockNum, err)
				errors++
				continue
			}

			localBalance := new(big.Int)
			if localAcct != nil {
				localBalance.SetBytes(localAcct.Balance[:])
			}

			// Query remote archival RPC
			remoteBalance, err := ethGetBalance(rpcURL, addrHex, blockNum)
			if err != nil {
				fmt.Printf("  block %d: RPC ERROR: %v\n", blockNum, err)
				errors++
				continue
			}

			checked++
			if localBalance.Cmp(remoteBalance) == 0 {
				matched++
			} else {
				mismatched++
				fmt.Printf("  block %d: MISMATCH local=%s remote=%s\n",
					blockNum, localBalance.String(), remoteBalance.String())
			}
		}
	}

	fmt.Printf("\n--- Results ---\n")
	fmt.Printf("Checked:    %d\n", checked)
	fmt.Printf("Matched:    %d\n", matched)
	fmt.Printf("Mismatched: %d\n", mismatched)
	fmt.Printf("Errors:     %d\n", errors)

	if mismatched > 0 {
		os.Exit(1)
	}
}
