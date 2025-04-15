package main

import (
	"context"
	"fmt"

	"github.com/ava-labs/avalanchego/ids"
	avalancheWarp "github.com/ava-labs/avalanchego/vms/platformvm/warp"
	"github.com/ava-labs/avalanchego/vms/platformvm/warp/payload"
	teleportermessenger "github.com/ava-labs/icm-contracts/abi-bindings/go/teleporter/TeleporterMessenger"
	teleporterUtils "github.com/ava-labs/icm-contracts/utils/teleporter-utils"
	"github.com/ava-labs/subnet-evm/accounts/abi/bind"
	"github.com/ava-labs/subnet-evm/ethclient"
	"github.com/containerman17/experiments/2025-04/turborelayer-mvp/aggregator"
	"github.com/ethereum/go-ethereum/common"
)

// DeliverMessageParams holds all parameters needed for delivering a message
type DeliverMessageParams struct {
	UnsignedMsg             *avalancheWarp.UnsignedMessage
	SourceClient            ethclient.Client
	DestClient              ethclient.Client
	DestTeleporterMessenger *teleportermessenger.TeleporterMessenger
	DestChainIDStr          string
	AggWrapper              *aggregator.AggregatorWrapper
}

func deliverMessage(params DeliverMessageParams) error {
	//check chain id
	addressedPayload, err := payload.ParseAddressedCall(params.UnsignedMsg.Payload)
	if err != nil {
		return fmt.Errorf("failed to parse payload: %w", err)
	}

	var teleporterMessage teleportermessenger.TeleporterMessage
	err = teleporterMessage.Unpack(addressedPayload.Payload)
	if err != nil {
		return fmt.Errorf("failed to unpack teleporter message: %w", err)
	}

	// Successfully parsed Teleporter message, check destination chain
	chainID, err := ids.ToID(teleporterMessage.DestinationBlockchainID[:])
	if err != nil {
		return fmt.Errorf("failed to convert chain ID: %w", err)
	}

	if chainID.String() != params.DestChainIDStr {
		return fmt.Errorf("destination chain ID does not match: %s", chainID.String())
	}

	//check for duplicates
	teleporterMessageID, err := teleporterUtils.CalculateMessageID(
		common.HexToAddress(TELEPORTER_MESSENGER_ADDRESS),
		params.UnsignedMsg.SourceChainID,
		teleporterMessage.DestinationBlockchainID,
		teleporterMessage.MessageNonce,
	)
	if err != nil {
		return fmt.Errorf("failed to calculate message ID: %w", err)
	}

	delivered, err := params.DestTeleporterMessenger.MessageReceived(&bind.CallOpts{}, teleporterMessageID)
	if err != nil {
		// Handle error
		return err
	}

	if delivered {
		return nil //already delivered
	}

	//deliver message
	signed, err := params.AggWrapper.Sign(context.TODO(), params.UnsignedMsg)
	if err != nil {
		return fmt.Errorf("failed to sign message: %w", err)
	}

	_ = signed //TODO:implement tx sending
	return nil
}
