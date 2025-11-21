package main

import (
	"encoding/hex"
	"fmt"
	"log"
	"os"

	"github.com/ava-labs/avalanchego/codec"
	"github.com/ava-labs/coreth/plugin/evm/atomic"
)

func decodeExtData(hexStr string, c codec.Manager) {
	data, err := hex.DecodeString(hexStr)
	if err != nil {
		log.Fatalf("Failed to decode hex: %v", err)
	}

	fmt.Printf("ExtData length: %d bytes\n\n", len(data))

	// Try decoding as batch (post-AP5)
	txs, err := atomic.ExtractAtomicTxs(data, true, c)
	if err != nil {
		fmt.Printf("Failed to decode as batch (post-AP5): %v\n", err)
		// Try decoding as single (pre-AP5)
		txs, err = atomic.ExtractAtomicTxs(data, false, c)
		if err != nil {
			fmt.Printf("Failed to decode as single tx (pre-AP5): %v\n\n", err)
			fmt.Println("Raw hex dump (first 256 bytes):")
			if len(data) > 256 {
				fmt.Printf("%x\n", data[:256])
			} else {
				fmt.Printf("%x\n", data)
			}
			return
		}
		fmt.Println("Decoded as single atomic transaction (pre-AP5)")
	} else {
		fmt.Printf("Decoded as batch atomic transactions (post-AP5)\n")
	}

	fmt.Printf("\nFound %d atomic transaction(s):\n", len(txs))
	for i, tx := range txs {
		fmt.Printf("\n=== Transaction %d ===\n", i)
		txID := tx.ID()
		fmt.Printf("ID: 0x%x\n", txID[:])

		switch utx := tx.UnsignedAtomicTx.(type) {
		case *atomic.UnsignedImportTx:
			fmt.Printf("Type: ImportTx\n")
			fmt.Printf("NetworkID: %d\n", utx.NetworkID)
			fmt.Printf("BlockchainID: 0x%x\n", utx.BlockchainID[:])
			fmt.Printf("SourceChain: 0x%x\n", utx.SourceChain[:])
			fmt.Printf("ImportedInputs: %d\n", len(utx.ImportedInputs))
			for j, input := range utx.ImportedInputs {
				assetID := input.AssetID()
				fmt.Printf("  Input %d: UTXOID=0x%x:%d, AssetID=0x%x\n", j, input.UTXOID.TxID[:], input.UTXOID.OutputIndex, assetID[:])
			}
			fmt.Printf("Outputs: %d\n", len(utx.Outs))
			for j, out := range utx.Outs {
				fmt.Printf("  Output %d: Address=%s, Amount=%d, AssetID=0x%x\n", j, out.Address, out.Amount, out.AssetID[:])
			}
		case *atomic.UnsignedExportTx:
			fmt.Printf("Type: ExportTx\n")
			fmt.Printf("NetworkID: %d\n", utx.NetworkID)
			fmt.Printf("BlockchainID: 0x%x\n", utx.BlockchainID[:])
			fmt.Printf("DestinationChain: 0x%x\n", utx.DestinationChain[:])
			fmt.Printf("Inputs: %d\n", len(utx.Ins))
			for j, input := range utx.Ins {
				fmt.Printf("  Input %d: Address=%s, Amount=%d, AssetID=0x%x, Nonce=%d\n", j, input.Address, input.Amount, input.AssetID[:], input.Nonce)
			}
			fmt.Printf("ExportedOutputs: %d\n", len(utx.ExportedOutputs))
			for j, out := range utx.ExportedOutputs {
				assetID := out.AssetID()
				fmt.Printf("  Output %d: AssetID=0x%x\n", j, assetID[:])
			}
		}
		fmt.Printf("Credentials: %d\n", len(tx.Creds))
	}
}

func main() {
	if len(os.Args) < 2 {
		fmt.Println("Usage: go run decode_extra.go <hex_string>")
		return
	}
	hexStr := os.Args[1]
	// Clean up potential 0x prefix
	if len(hexStr) > 2 && hexStr[:2] == "0x" {
		hexStr = hexStr[2:]
	}

	decodeExtData(hexStr, atomic.Codec)
}
