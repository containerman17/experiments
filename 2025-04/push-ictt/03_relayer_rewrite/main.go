package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"math/big"
	"os"
	"time"

	// AvalancheGo dependencies
	"github.com/ava-labs/avalanchego/ids"
	avalancheWarp "github.com/ava-labs/avalanchego/vms/platformvm/warp"
	warpPayload "github.com/ava-labs/avalanchego/vms/platformvm/warp/payload"

	// Go-Ethereum dependencies
	"github.com/ethereum/go-ethereum/common"
	// Subnet-EVM dependencies
	"github.com/ava-labs/subnet-evm/ethclient"
	"github.com/ava-labs/subnet-evm/interfaces"
	subnetWarp "github.com/ava-labs/subnet-evm/precompile/contracts/warp"

	// ICM Contracts dependencies
	teleportermessenger "github.com/ava-labs/icm-contracts/abi-bindings/go/teleporter/TeleporterMessenger"
)

// WarpPrecompileLogFilter is the EVM log topic for SendWarpMessage events.
var WarpPrecompileLogFilter = subnetWarp.WarpABI.Events["SendWarpMessage"].ID

// UnpackWarpMessage attempts to parse the raw bytes from a log's Data field
// into an UnsignedMessage.
func UnpackWarpMessage(unsignedMsgBytes []byte) (*avalancheWarp.UnsignedMessage, error) {
	// Try unpacking using subnet-evm's helper first
	unsignedMsg, err := subnetWarp.UnpackSendWarpEventDataToMessage(unsignedMsgBytes)
	if err == nil {
		return unsignedMsg, nil
	}

	// Fallback to avalanchego's parser
	unsignedMsg, standaloneErr := avalancheWarp.ParseUnsignedMessage(unsignedMsgBytes)
	if standaloneErr != nil {
		return nil, fmt.Errorf("failed with subnet-evm unpacker (%w) and avalanchego parser (%w)", err, standaloneErr)
	}
	return unsignedMsg, nil
}

// parseBlockWarps fetches and filters Warp messages from the specified block.
// Only messages destined for destChainIDStr (if successfully parsed as Teleporter) are returned.
func parseBlockWarps(ctx context.Context, rpcURL string, blockNum uint64, destChainIDStr string) ([]*avalancheWarp.UnsignedMessage, error) {
	if rpcURL == "" {
		return nil, errors.New("RPC URL cannot be empty")
	}

	client, err := ethclient.DialContext(ctx, rpcURL)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to RPC endpoint: %w", err)
	}
	defer client.Close()

	targetBlock := big.NewInt(int64(blockNum))

	query := interfaces.FilterQuery{
		FromBlock: targetBlock,
		ToBlock:   targetBlock,
		Addresses: []common.Address{subnetWarp.ContractAddress},
		Topics:    [][]common.Hash{{WarpPrecompileLogFilter}},
	}

	logs, err := client.FilterLogs(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to filter logs for block %d: %w", blockNum, err)
	}

	var unsignedMessages []*avalancheWarp.UnsignedMessage
	for _, l := range logs {
		if len(l.Topics) == 0 || l.Topics[0] != WarpPrecompileLogFilter || l.Address != subnetWarp.ContractAddress {
			continue
		}

		unsignedMsg, err := UnpackWarpMessage(l.Data)
		if err != nil {
			continue // Skip if basic warp message parsing fails
		}

		// Attempt to parse payload for filtering
		addressedPayload, err := warpPayload.ParseAddressedCall(unsignedMsg.Payload)
		if err != nil {
			continue // Cannot determine destination, skip
		}

		var teleporterMessage teleportermessenger.TeleporterMessage
		err = teleporterMessage.Unpack(addressedPayload.Payload)
		if err != nil {
			continue // Not a teleporter message, cannot filter by dest chain ID, skip
		}

		// Successfully parsed Teleporter message, check destination chain
		chainID, err := ids.ToID(teleporterMessage.DestinationBlockchainID[:])
		if err != nil {
			continue // Error converting chain ID, skip
		}

		if chainID.String() == destChainIDStr {
			unsignedMessages = append(unsignedMessages, unsignedMsg)
		}
	}

	return unsignedMessages, nil
}

func main() {
	// Command line flags
	rpcURL := flag.String("rpc-url", "http://localhost:9650/ext/bc/PSPJDsDstwafoRHMH4ToeADFWm887WJzUe8shf3S8RLMHCMzZ/rpc", "RPC endpoint URL of the source blockchain")
	blockNum := flag.Uint64("block", 1000, "Block number to parse for Warp messages")
	destChainID := flag.String("dest-chain", "KGAehYuq9J951RHuooVVkiJ3YEMmjpNUKx2SmW5Reb7HdBhNT", "Destination chain ID to filter messages (required)")
	timeoutSec := flag.Uint("timeout", 10, "Timeout in seconds for RPC calls")
	flag.Parse()

	if *rpcURL == "" {
		fmt.Println("Error: -rpc-url flag is required.")
		flag.Usage()
		os.Exit(1)
	}

	if *destChainID == "" {
		fmt.Println("Error: -dest-chain flag is required.")
		flag.Usage()
		os.Exit(1)
	}

	// Create context with timeout
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(*timeoutSec)*time.Second)
	defer cancel()

	// Parse block for Warp messages
	messages, err := parseBlockWarps(ctx, *rpcURL, *blockNum, *destChainID)
	if err != nil {
		fmt.Printf("Error parsing block %d: %v\n", *blockNum, err)
		os.Exit(1)
	}

	// Print the result count
	fmt.Printf("Found %d messages\n", len(messages))
}
