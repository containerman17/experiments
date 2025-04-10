package main

import (
	"context"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"log"
	"math/big"
	"os"
	"time"

	// AvalancheGo dependencies
	"github.com/ava-labs/avalanchego/ids"
	avalancheWarp "github.com/ava-labs/avalanchego/vms/platformvm/warp"
	warpPayload "github.com/ava-labs/avalanchego/vms/platformvm/warp/payload" // Import for AddressedCall

	// Go-Ethereum dependencies
	"github.com/ethereum/go-ethereum/common"
	// Subnet-EVM dependencies (core types, ethclient, precompile info)
	"github.com/ava-labs/subnet-evm/ethclient"
	"github.com/ava-labs/subnet-evm/interfaces"
	subnetWarp "github.com/ava-labs/subnet-evm/precompile/contracts/warp" // Use subnetWarp alias

	// ICM Contracts dependencies
	teleportermessenger "github.com/ava-labs/icm-contracts/abi-bindings/go/teleporter/TeleporterMessenger" // Import for Teleporter details
	// Import the encoding package
)

// --- Replicated necessary parts from icm-services/types/types.go ---
// (To make this example standalone)
// WarpPrecompileLogFilter is the EVM log topic for SendWarpMessage events.
var WarpPrecompileLogFilter = subnetWarp.WarpABI.Events["SendWarpMessage"].ID

// UnpackWarpMessage attempts to parse the raw bytes from a log's Data field
// into an UnsignedMessage. It tries both the subnet-evm helper and the
// standalone avalanchego parser.
func UnpackWarpMessage(unsignedMsgBytes []byte) (*avalancheWarp.UnsignedMessage, error) {
	// Try unpacking using subnet-evm's helper first (expects specific event data format)
	unsignedMsg, err := subnetWarp.UnpackSendWarpEventDataToMessage(unsignedMsgBytes)
	if err == nil {
		return unsignedMsg, nil
	}
	// Fallback to avalanchego's parser if the first one fails
	// (This mirrors the logic in the original icm-services/types)
	log.Printf("DEBUG: Failed to parse warp message with subnet-evm helper (%v), trying avalanchego parser", err)
	unsignedMsg, standaloneErr := avalancheWarp.ParseUnsignedMessage(unsignedMsgBytes)
	if standaloneErr != nil {
		// Combine errors if both failed
		return nil, fmt.Errorf("failed with subnet-evm unpacker (%w) and avalanchego parser (%w)", err, standaloneErr)
	}
	return unsignedMsg, nil
}

// --- Core Logic ---
// parseBlockWarps connects to the RPC, fetches the specified block,
// filters logs for Warp messages, parses them, and prints details.
func parseBlockWarps(ctx context.Context, rpcURL string, blockNum uint64) error {
	if rpcURL == "" {
		return errors.New("RPC URL cannot be empty")
	}
	log.Printf("Connecting to RPC endpoint: %s", rpcURL)
	client, err := ethclient.DialContext(ctx, rpcURL)
	if err != nil {
		return fmt.Errorf("failed to connect to RPC endpoint: %w", err)
	}
	defer client.Close()
	log.Println("Connected successfully.")
	targetBlock := big.NewInt(int64(blockNum))
	log.Printf("Fetching header for block %d...", blockNum)
	header, err := client.HeaderByNumber(ctx, targetBlock)
	if err != nil {
		// Handle cases where block might not exist yet or other RPC errors
		if errors.Is(err, context.DeadlineExceeded) {
			return fmt.Errorf("timeout fetching header for block %d: %w", blockNum, err)
		}
		return fmt.Errorf("failed to get header for block %d: %w", blockNum, err)
	}
	log.Printf("Fetched header for block %d (Hash: %s)", blockNum, header.Hash().Hex())
	// Optional: Check Bloom Filter for quick exit if no warp logs are possible
	// This saves an RPC call if the filter is definitive.
	if !header.Bloom.Test(WarpPrecompileLogFilter[:]) {
		log.Printf("Bloom filter indicates no Warp messages in block %d. Skipping log query.", blockNum)
		return nil
	}
	log.Printf("Bloom filter check passed for block %d. Querying logs...", blockNum)
	// Define the filter query
	query := interfaces.FilterQuery{
		FromBlock: targetBlock,
		ToBlock:   targetBlock, // Query only the specific block
		Addresses: []common.Address{
			subnetWarp.ContractAddress, // Only logs from the Warp precompile
		},
		Topics: [][]common.Hash{
			{WarpPrecompileLogFilter}, // Only logs matching the SendWarpMessage event
		},
	}
	logs, err := client.FilterLogs(ctx, query)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return fmt.Errorf("timeout filtering logs for block %d: %w", blockNum, err)
		}
		return fmt.Errorf("failed to filter logs for block %d: %w", blockNum, err)
	}
	if len(logs) == 0 {
		log.Printf("No Warp messages found in block %d after filtering.", blockNum)
		return nil
	}
	log.Printf("Found %d potential Warp message log(s) in block %d. Parsing...", len(logs), blockNum)
	fmt.Println("--------------------------------------------------")
	fmt.Printf("Warp Messages in Block %d:\n", blockNum)
	fmt.Println("--------------------------------------------------")
	foundCount := 0
	for i, l := range logs {
		// Sanity check topic
		if len(l.Topics) == 0 || l.Topics[0] != WarpPrecompileLogFilter {
			log.Printf("WARN: Log %d/%d has incorrect topic, skipping.", i+1, len(logs))
			continue
		}
		// Sanity check address
		if l.Address != subnetWarp.ContractAddress {
			log.Printf("WARN: Log %d/%d has incorrect address (%s), skipping.", i+1, len(logs), l.Address.Hex())
			continue
		}
		unsignedMsg, err := UnpackWarpMessage(l.Data)
		if err != nil {
			log.Printf("ERROR: Failed to parse log data %d/%d into Warp message: %v", i+1, len(logs), err)
			log.Printf("       Raw Data: %s", hex.EncodeToString(l.Data))
			continue
		}
		// Extract source address from topic[1] if available (as seen in icm-services/types)
		var sourceAddr common.Address
		if len(l.Topics) >= 2 { // Topic[0] is event sig, Topic[1] is often indexed source address
			sourceAddr = common.BytesToAddress(l.Topics[1][:])
		}
		// --- Attempt to parse destination from payload ---
		destChainIDStr := "(N/A)"
		destAddrHex := "(N/A)"
		payloadHex := hex.EncodeToString(unsignedMsg.Payload) // Default to showing raw payload
		addressedPayload, err := warpPayload.ParseAddressedCall(unsignedMsg.Payload)
		if err == nil {
			// Successfully parsed AddressedCall, now try Teleporter
			var teleporterMessage teleportermessenger.TeleporterMessage
			err = teleporterMessage.Unpack(addressedPayload.Payload)
			if err == nil {
				// Successfully parsed Teleporter message
				chainID, err := ids.ToID(teleporterMessage.DestinationBlockchainID[:])
				if err != nil {
					log.Printf("ERROR: Failed to convert destination blockchain ID to ID: %v", err)
				}
				destChainIDStr = chainID.String()
				destAddrHex = teleporterMessage.DestinationAddress.Hex()
				payloadHex = hex.EncodeToString(teleporterMessage.Message)
			} else {
				log.Printf("DEBUG: Message %d: Payload is AddressedCall but not Teleporter: %v", foundCount+1, err)
				payloadHex = fmt.Sprintf("0x%s (AddressedCall, Inner Payload: 0x%s)",
					hex.EncodeToString(unsignedMsg.Payload),
					hex.EncodeToString(addressedPayload.Payload)) // Show inner payload on failure
				destChainIDStr = "(N/A - Not Teleporter)"
				destAddrHex = "(N/A - Not Teleporter)"
			}
		} else {
			log.Printf("DEBUG: Message %d: Payload is not AddressedCall: %v", foundCount+1, err)
			destChainIDStr = "(N/A - Not AddressedCall)"
			destAddrHex = "(N/A - Not AddressedCall)"
			// Keep payloadHex as the raw payload
		}
		// --- End Payload Parsing ---
		fmt.Printf("Message %d:\n", foundCount+1)
		fmt.Printf("  Log Index:        %d\n", l.Index)
		fmt.Printf("  Tx Hash:          %s\n", l.TxHash.Hex())
		fmt.Printf("  Emitted By Addr:  %s\n", l.Address.Hex())
		fmt.Printf("  Source Addr (Log):%s\n", sourceAddr.Hex()) // Address emitting the log via precompile
		fmt.Println("  --- Parsed Unsigned Warp Message ---")
		fmt.Printf("  Warp Message ID:  %s\n", unsignedMsg.ID().String())
		fmt.Printf("  Network ID:       %d\n", unsignedMsg.NetworkID)
		fmt.Printf("  Source Chain ID:  %s\n", unsignedMsg.SourceChainID.String())
		fmt.Printf("  Dest Chain ID:    %s\n", destChainIDStr) // Added
		fmt.Printf("  Dest Address:     %s\n", destAddrHex)    // Added
		fmt.Printf("  Payload (Hex):    0x%s\n", payloadHex)
		fmt.Println("  ------------------------------------")
		fmt.Println() // Blank line for separation
		foundCount++
	}
	if foundCount == 0 {
		log.Printf("Processed %d logs, but none could be successfully parsed into Warp messages.", len(logs))
	} else {
		log.Printf("Successfully parsed and printed %d Warp message(s) from block %d.", foundCount, blockNum)
	}
	return nil
}

// --- Main Execution ---
func main() {
	// --- Command Line Flags ---
	rpcURL := flag.String("rpc-url", "", "RPC endpoint URL of the source blockchain (e.g., http://localhost:9650/ext/bc/CHAIN_ID/rpc)")
	blockNum := flag.Uint64("block", 0, "Block number to parse for Warp messages")
	timeoutSec := flag.Uint("timeout", 10, "Timeout in seconds for RPC calls")
	flag.Parse()
	if *rpcURL == "" {
		fmt.Println("Error: -rpc-url flag is required.")
		flag.Usage()
		os.Exit(1)
	}
	// No specific check for block 0, might be valid depending on chain
	// --- Context for RPC Calls ---
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(*timeoutSec)*time.Second)
	defer cancel()
	// --- Run the Parser ---
	err := parseBlockWarps(ctx, *rpcURL, *blockNum)
	if err != nil {
		log.Fatalf("Error parsing block %d: %v", *blockNum, err)
	}
	log.Println("Finished.")
}
