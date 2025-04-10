package main

import (
	"context"
	"errors"
	"fmt"
	"math/big"

	"github.com/ava-labs/avalanchego/ids"
	avalancheWarp "github.com/ava-labs/avalanchego/vms/platformvm/warp"
	"github.com/ava-labs/avalanchego/vms/platformvm/warp/payload"
	teleportermessenger "github.com/ava-labs/icm-contracts/abi-bindings/go/teleporter/TeleporterMessenger"
	"github.com/ava-labs/icm-services/types"
	"github.com/ava-labs/subnet-evm/ethclient"
	"github.com/ava-labs/subnet-evm/interfaces"
	subnetWarp "github.com/ava-labs/subnet-evm/precompile/contracts/warp"
	"github.com/ethereum/go-ethereum/common"
)

var WarpPrecompileLogFilter = subnetWarp.WarpABI.Events["SendWarpMessage"].ID

func parseBlockWarps(ctx context.Context, rpcURL string, fromBlock *big.Int, toBlock *big.Int, destChainIDStr string) ([]*avalancheWarp.UnsignedMessage, error) {
	if rpcURL == "" {
		return nil, errors.New("RPC URL cannot be empty")
	}

	client, err := ethclient.DialContext(ctx, rpcURL)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to RPC endpoint: %w", err)
	}
	defer client.Close()

	query := interfaces.FilterQuery{
		FromBlock: fromBlock,
		ToBlock:   toBlock,
		Addresses: []common.Address{subnetWarp.ContractAddress},
		Topics:    [][]common.Hash{{WarpPrecompileLogFilter}},
	}

	logs, err := client.FilterLogs(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to filter logs for block %d: %w", fromBlock, err)
	}

	var unsignedMessages []*avalancheWarp.UnsignedMessage
	for _, l := range logs {
		if len(l.Topics) == 0 || l.Topics[0] != WarpPrecompileLogFilter || l.Address != subnetWarp.ContractAddress {
			continue
		}

		unsignedMsg, err := types.UnpackWarpMessage(l.Data)
		if err != nil {
			continue // Skip if basic warp message parsing fails
		}

		// Attempt to parse payload for filtering
		addressedPayload, err := payload.ParseAddressedCall(unsignedMsg.Payload)
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
