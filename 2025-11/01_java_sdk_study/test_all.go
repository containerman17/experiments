package main

import (
	"bufio"
	"bytes"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/ava-labs/coreth/plugin/evm/atomic"
)

func decodeHex(hexStr string) string {
	if len(hexStr) > 2 && hexStr[:2] == "0x" {
		hexStr = hexStr[2:]
	}

	data, err := hex.DecodeString(hexStr)
	if err != nil {
		return fmt.Sprintf("Failed to decode hex: %v", err)
	}

	var out strings.Builder
	fmt.Fprintf(&out, "ExtData length: %d bytes\n\n", len(data))

	txs, err := atomic.ExtractAtomicTxs(data, true, atomic.Codec)
	if err != nil {
		txs, err = atomic.ExtractAtomicTxs(data, false, atomic.Codec)
		if err != nil {
			fmt.Fprintf(&out, "Failed to decode as batch (post-AP5): %v\n", err)
			fmt.Fprintf(&out, "Failed to decode as single tx (pre-AP5): %v\n\n", err)
			fmt.Fprintln(&out, "Raw hex dump (first 256 bytes):")
			if len(data) > 256 {
				fmt.Fprintf(&out, "%x\n", data[:256])
			} else {
				fmt.Fprintf(&out, "%x\n", data)
			}
			return out.String()
		}
		fmt.Fprintln(&out, "Decoded as single atomic transaction (pre-AP5)")
	} else {
		fmt.Fprintln(&out, "Decoded as batch atomic transactions (post-AP5)")
	}

	fmt.Fprintf(&out, "\nFound %d atomic transaction(s):\n", len(txs))
	for i, tx := range txs {
		fmt.Fprintf(&out, "\n=== Transaction %d ===\n", i)
		txID := tx.ID()
		fmt.Fprintf(&out, "ID: 0x%x\n", txID[:])

		switch utx := tx.UnsignedAtomicTx.(type) {
		case *atomic.UnsignedImportTx:
			fmt.Fprintln(&out, "Type: ImportTx")
			fmt.Fprintf(&out, "NetworkID: %d\n", utx.NetworkID)
			fmt.Fprintf(&out, "BlockchainID: 0x%x\n", utx.BlockchainID[:])
			fmt.Fprintf(&out, "SourceChain: 0x%x\n", utx.SourceChain[:])
			fmt.Fprintf(&out, "ImportedInputs: %d\n", len(utx.ImportedInputs))
			for j, input := range utx.ImportedInputs {
				assetID := input.AssetID()
				fmt.Fprintf(&out, "  Input %d: UTXOID=0x%x:%d, AssetID=0x%x\n", j, input.UTXOID.TxID[:], input.UTXOID.OutputIndex, assetID[:])
			}
			fmt.Fprintf(&out, "Outputs: %d\n", len(utx.Outs))
			for j, o := range utx.Outs {
				fmt.Fprintf(&out, "  Output %d: Address=%s, Amount=%d, AssetID=0x%x\n", j, strings.ToLower(o.Address.String()), o.Amount, o.AssetID[:])
			}
		case *atomic.UnsignedExportTx:
			fmt.Fprintln(&out, "Type: ExportTx")
			fmt.Fprintf(&out, "NetworkID: %d\n", utx.NetworkID)
			fmt.Fprintf(&out, "BlockchainID: 0x%x\n", utx.BlockchainID[:])
			fmt.Fprintf(&out, "DestinationChain: 0x%x\n", utx.DestinationChain[:])
			fmt.Fprintf(&out, "Inputs: %d\n", len(utx.Ins))
			for j, input := range utx.Ins {
				fmt.Fprintf(&out, "  Input %d: Address=%s, Amount=%d, AssetID=0x%x, Nonce=%d\n", j, strings.ToLower(input.Address.String()), input.Amount, input.AssetID[:], input.Nonce)
			}
			fmt.Fprintf(&out, "ExportedOutputs: %d\n", len(utx.ExportedOutputs))
			for j, o := range utx.ExportedOutputs {
				assetID := o.AssetID()
				fmt.Fprintf(&out, "  Output %d: AssetID=0x%x\n", j, assetID[:])
			}
		}
		fmt.Fprintf(&out, "Credentials: %d\n", len(tx.Creds))
	}

	return out.String()
}

func main() {
	// Compile Java first
	fmt.Println("Compiling Java...")
	if err := exec.Command("javac", "BlockExtraDataDemo.java").Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to compile Java: %v\n", err)
		os.Exit(1)
	}

	f, err := os.Open("blocks.csv")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to open blocks.csv: %v\n", err)
		os.Exit(1)
	}
	defer f.Close()

	total := 0
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		commaIdx := strings.Index(line, ",")
		if commaIdx == -1 {
			continue
		}

		hexData := strings.Trim(line[commaIdx+1:], `"`)
		total++

		if total%100 == 0 {
			fmt.Printf("Processed %d...\n", total)
		}

		goOut := decodeHex(hexData)
		javaOut, javaErr := exec.Command("java", "BlockExtraDataDemo", hexData).Output()

		if javaErr != nil || strings.TrimSpace(goOut) != string(bytes.TrimSpace(javaOut)) {
			fmt.Printf("FAILED at %d: %s\n", total, hexData)
			os.Exit(1)
		}
	}

	fmt.Printf("All %d tests passed\n", total)
}
