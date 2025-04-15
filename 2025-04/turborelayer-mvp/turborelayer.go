package main

import (
	"context"
	"fmt"
	"math/big"

	"github.com/ava-labs/avalanchego/ids"
	teleportermessenger "github.com/ava-labs/icm-contracts/abi-bindings/go/teleporter/TeleporterMessenger"
	"github.com/ava-labs/subnet-evm/ethclient"
	"github.com/containerman17/experiments/2025-04/turborelayer-mvp/aggregator"
	"github.com/ethereum/go-ethereum/common"
)

type TurboRelayerMVP struct {
	aggWrapper              *aggregator.AggregatorWrapper
	sourceEthClient         ethclient.Client
	destEthClient           ethclient.Client
	destTeleporterMessenger *teleportermessenger.TeleporterMessenger
	destChainIDStr          string
}

func CreateTurboRelayerMVP(sourceSubnetID ids.ID, sourceRPCURL string, destChainID string, destRPCURL string) (*TurboRelayerMVP, error) {
	// Initialize Aggregator Wrapper
	aggWrapper, err := aggregator.NewAggregatorWrapper(sourceSubnetID)
	if err != nil {
		return nil, fmt.Errorf("Error creating aggregator wrapper: %v\n", err)
	}

	sourceEthClient, err := ethclient.DialContext(context.TODO(), sourceRPCURL)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to RPC endpoint: %v\n", err)
	}

	destEthClient, err := ethclient.DialContext(context.TODO(), destRPCURL)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to RPC endpoint: %v\n", err)
	}

	destTeleporterMessenger, err := teleportermessenger.NewTeleporterMessenger(common.HexToAddress(TELEPORTER_MESSENGER_ADDRESS), destEthClient)
	if err != nil {
		return nil, fmt.Errorf("failed to create teleporter messenger: %v\n", err)
	}

	return &TurboRelayerMVP{
		aggWrapper:              aggWrapper,
		sourceEthClient:         sourceEthClient,
		destEthClient:           destEthClient,
		destTeleporterMessenger: destTeleporterMessenger,
		destChainIDStr:          destChainID,
	}, nil
}

func (t *TurboRelayerMVP) handleBlock(blockNumber *big.Int) (int, int) {
	successCount := 0
	failureCount := 0

	messages, err := parseBlockWarps(context.TODO(), blockNumber, t.sourceEthClient)
	if err != nil {
		fmt.Printf("Error parsing block %s: %v\n", blockNumber.String(), err)
		return 0, 0
	}

	if len(messages) == 0 {
		return 0, 0
	}

	for _, msg := range messages {
		err := deliverMessage(DeliverMessageParams{
			UnsignedMsg:             msg,
			SourceClient:            t.sourceEthClient,
			DestClient:              t.destEthClient,
			DestTeleporterMessenger: t.destTeleporterMessenger,
			DestChainIDStr:          t.destChainIDStr,
		})
		if err != nil {
			failureCount++
		} else {
			successCount++
		}
	}

	return successCount, failureCount
}
