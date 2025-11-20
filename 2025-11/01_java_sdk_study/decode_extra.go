package main

import (
	"encoding/hex"
	"fmt"
	"log"

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
		fmt.Printf("ID: %s\n", tx.ID())

		switch utx := tx.UnsignedAtomicTx.(type) {
		case *atomic.UnsignedImportTx:
			fmt.Printf("Type: ImportTx\n")
			fmt.Printf("NetworkID: %d\n", utx.NetworkID)
			fmt.Printf("BlockchainID: %s\n", utx.BlockchainID)
			fmt.Printf("SourceChain: %s\n", utx.SourceChain)
			fmt.Printf("ImportedInputs: %d\n", len(utx.ImportedInputs))
			for j, input := range utx.ImportedInputs {
				fmt.Printf("  Input %d: UTXOID=%s, AssetID=%s\n", j, input.UTXOID, input.AssetID)
			}
			fmt.Printf("Outputs: %d\n", len(utx.Outs))
			for j, out := range utx.Outs {
				fmt.Printf("  Output %d: Address=%s, Amount=%d, AssetID=%s\n", j, out.Address, out.Amount, out.AssetID)
			}
		case *atomic.UnsignedExportTx:
			fmt.Printf("Type: ExportTx\n")
			fmt.Printf("NetworkID: %d\n", utx.NetworkID)
			fmt.Printf("BlockchainID: %s\n", utx.BlockchainID)
			fmt.Printf("DestinationChain: %s\n", utx.DestinationChain)
			fmt.Printf("Inputs: %d\n", len(utx.Ins))
			for j, input := range utx.Ins {
				fmt.Printf("  Input %d: Address=%s, Amount=%d, AssetID=%s, Nonce=%d\n", j, input.Address, input.Amount, input.AssetID, input.Nonce)
			}
			fmt.Printf("ExportedOutputs: %d\n", len(utx.ExportedOutputs))
			for j, out := range utx.ExportedOutputs {
				fmt.Printf("  Output %d: AssetID=%s\n", j, out.AssetID)
			}
		}
		fmt.Printf("Credentials: %d\n", len(tx.Creds))
	}
}

func main() {
	example1 := "00000000000000003039c85fc1980a77c5da78fe5486233fc09a769bb812bcb2cc548cf9495d046b3f1bd891ad56056d9c01f18f43f58b5c784ad07a4a49cf3d1f11623804b5cba2c6bf000000028a0f7c3e4d840143671a4c4ecacccb4d60fb97dce97a7aa5d60dfd072a7509cf00000001dbcf890f77f49b96857648b72b77f9f82937f28a68704af05da0dc12ba53f2db0000000500002d79883d20000000000100000000e0d5c4edc78f594b79025a56c44933c28e8ba3e51e6e23318727eeaac10eb27d00000001dbcf890f77f49b96857648b72b77f9f82937f28a68704af05da0dc12ba53f2db0000000500002d79883d20000000000100000000000000016dc8ea73dd39ab12fa2ecbc3427abaeb87d56fd800005af3107a4000dbcf890f77f49b96857648b72b77f9f82937f28a68704af05da0dc12ba53f2db0000000200000009000000010d9f115cd63c3ab78b5b82cfbe4339cd6be87f21cda14cf192b269c7a6cb2d03666aa8f8b23ca0a2ceee4050e75c9b05525a17aa1dd0e9ea391a185ce395943f00"

	example2 := "00000000000100000001000000010427D4B22A2A78BCDDD456742CAF91B56BADBFF985EE19AEF14573E7343FD652000000000000000000000000000000000000000000000000000000000000000000000001565F0FE9715E3CB0DF579F186C299D6707887E830000000DC7D44F6F21E67317CBC4BE2AEB00677AD6462778A8F52274B9D605DF2591B23027A87DFF0000000000025FCD0000000121E67317CBC4BE2AEB00677AD6462778A8F52274B9D605DF2591B23027A87DFF000000070000000DC7D42391000000000000000000000001000000015CF998275803A7277926912DEFDF177B2E97B0B4000000010000000900000001C1B39952DF371D6AC3CB7615630DC279DEC7A471C1C355738C0FA087B41FD5C317AC85D312B4DC01C9B37513BCAC98465CF7A834F8A291536AAB1C6403D29D1B01"

	fmt.Println("==========================================")
	fmt.Println("EXAMPLE 1 (from test)")
	fmt.Println("==========================================")
	decodeExtData(example1, atomic.Codec)

	fmt.Println("\n\n==========================================")
	fmt.Println("EXAMPLE 2 (real example)")
	fmt.Println("==========================================")
	decodeExtData(example2, atomic.Codec)
}
