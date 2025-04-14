// Copyright (C) 2024, Ava Labs, Inc. All rights reserved.
// See the file LICENSE for licensing terms.

package aggregator

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"math/big"
	"math/rand"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ava-labs/avalanchego/api/info"
	"github.com/ava-labs/avalanchego/ids"
	"github.com/ava-labs/avalanchego/message"
	networkP2P "github.com/ava-labs/avalanchego/network/p2p"
	"github.com/ava-labs/avalanchego/network/peer"
	"github.com/ava-labs/avalanchego/proto/pb/p2p"
	"github.com/ava-labs/avalanchego/proto/pb/sdk"
	"github.com/ava-labs/avalanchego/subnets"
	"github.com/ava-labs/avalanchego/utils/constants"
	"github.com/ava-labs/avalanchego/utils/crypto/bls"
	"github.com/ava-labs/avalanchego/utils/logging"
	"github.com/ava-labs/avalanchego/utils/rpc"
	"github.com/ava-labs/avalanchego/utils/set"
	"github.com/ava-labs/avalanchego/utils/units"
	"github.com/ava-labs/avalanchego/vms/platformvm"
	avalancheWarp "github.com/ava-labs/avalanchego/vms/platformvm/warp"
	basecfg "github.com/ava-labs/icm-services/config"
	"github.com/ava-labs/icm-services/peers"
	peerUtils "github.com/ava-labs/icm-services/peers/utils"
	"github.com/ava-labs/icm-services/signature-aggregator/aggregator/cache"
	"github.com/ava-labs/icm-services/signature-aggregator/metrics"
	sigAggMetrics "github.com/ava-labs/icm-services/signature-aggregator/metrics"
	"github.com/ava-labs/icm-services/utils"
	"github.com/cenkalti/backoff/v4"
	"github.com/prometheus/client_golang/prometheus"
	"go.uber.org/zap"
	"google.golang.org/protobuf/proto"
)

type blsSignatureBuf [bls.SignatureLen]byte

const (
	// Maximum amount of time to spend waiting (in addition to network round trip time per attempt)
	// during relayer signature query routine
	signatureRequestTimeout = 5 * time.Second
	// Maximum amount of time to spend waiting for a connection to a quorum of validators for
	// a given subnetID
	connectToValidatorsTimeout = 5 * time.Second

	// The minimum balance that an L1 validator must maintain in order to participate
	// in the aggregate signature.
	minimumL1ValidatorBalance = 2048 * units.NanoAvax
)

var (
	// Errors
	errInvalidQuorumPercentage = errors.New("invalid total quorum percentage")
	errNotEnoughSignatures     = errors.New("failed to collect a threshold of signatures")
	errNotEnoughConnectedStake = errors.New("failed to connect to a threshold of stake")
)

type SignatureAggregator struct {
	network peers.AppRequestNetwork
	// protected by subnetsMapLock
	subnetIDsByBlockchainID map[ids.ID]ids.ID
	logger                  logging.Logger
	messageCreator          message.Creator
	currentRequestID        atomic.Uint32
	subnetsMapLock          sync.RWMutex
	metrics                 *metrics.SignatureAggregatorMetrics
	cache                   *cache.Cache
	pChainClient            platformvm.Client
	pChainClientOptions     []rpc.Option
	l1ValidatorsCache       map[ids.ID][]platformvm.APIL1Validator
	l1ValidatorsCacheLock   sync.RWMutex
	getSubnetCache          map[ids.ID]platformvm.GetSubnetClientResponse
	getSubnetCacheLock      sync.RWMutex

	// New fields to cache validator connections per subnet
	connectedValidatorsMap        map[ids.ID]*peers.ConnectedCanonicalValidators
	connectedValidatorsLock       sync.RWMutex
	defaultQuorumPercentage       uint64
	defaultQuorumPercentageBuffer uint64
}

func NewSignatureAggregator(
	network peers.AppRequestNetwork,
	logger logging.Logger,
	messageCreator message.Creator,
	signatureCacheSize uint64,
	metrics *metrics.SignatureAggregatorMetrics,
	pChainClient platformvm.Client,
	pChainClientOptions []rpc.Option,
) (*SignatureAggregator, error) {
	cache, err := cache.NewCache(signatureCacheSize, logger)
	if err != nil {
		return nil, fmt.Errorf(
			"failed to create signature cache: %w",
			err,
		)
	}
	sa := SignatureAggregator{
		network:                       network,
		subnetIDsByBlockchainID:       map[ids.ID]ids.ID{},
		logger:                        logger,
		metrics:                       metrics,
		currentRequestID:              atomic.Uint32{},
		cache:                         cache,
		messageCreator:                messageCreator,
		pChainClient:                  pChainClient,
		pChainClientOptions:           pChainClientOptions,
		l1ValidatorsCache:             make(map[ids.ID][]platformvm.APIL1Validator),
		l1ValidatorsCacheLock:         sync.RWMutex{},
		getSubnetCache:                make(map[ids.ID]platformvm.GetSubnetClientResponse),
		getSubnetCacheLock:            sync.RWMutex{},
		connectedValidatorsMap:        make(map[ids.ID]*peers.ConnectedCanonicalValidators),
		connectedValidatorsLock:       sync.RWMutex{},
		defaultQuorumPercentage:       67, // Default value
		defaultQuorumPercentageBuffer: 3,  // Default value
	}
	sa.currentRequestID.Store(rand.Uint32())
	return &sa, nil
}

func (s *SignatureAggregator) Shutdown() {
	s.network.Shutdown()
}

// InitializeSubnetConnections pre-connects to validators for the specified subnets
// Call this during startup for any subnet you plan to use with CreateSignedMessage
func (s *SignatureAggregator) InitializeSubnetConnections(
	ctx context.Context,
	subnetIDs []ids.ID,
	quorumPercentage uint64,
) error {
	for _, subnetID := range subnetIDs {
		s.logger.Info("Pre-connecting to validators for subnet", zap.String("subnetID", subnetID.String()))

		// Track the subnet in the network
		s.network.TrackSubnet(subnetID)

		// Connect to validators
		connectedValidators, err := s.connectToQuorumValidatorsInternal(subnetID, quorumPercentage)
		if err != nil {
			return fmt.Errorf("failed to connect to validators for subnet %s: %w", subnetID, err)
		}

		// Cache connected validators
		s.connectedValidatorsLock.Lock()
		s.connectedValidatorsMap[subnetID] = connectedValidators
		s.connectedValidatorsLock.Unlock()

		// Also initialize L1 validators cache if needed
		if subnetID != constants.PrimaryNetworkID {
			subnet, err := s.GetSubnetCached(ctx, subnetID, s.pChainClientOptions...)
			if err != nil {
				s.logger.Warn(
					"Failed to cache subnet info during initialization",
					zap.String("subnetID", subnetID.String()),
					zap.Error(err),
				)
				continue
			}

			if subnet.ConversionID != ids.Empty {
				_, err = s.GetCurrentL1ValidatorsCached(ctx, subnetID, s.pChainClientOptions...)
				if err != nil {
					s.logger.Warn(
						"Failed to cache L1 validators during initialization",
						zap.String("subnetID", subnetID.String()),
						zap.Error(err),
					)
				}
			}
		}
	}

	return nil
}

// Internal method that doesn't cache the result
func (s *SignatureAggregator) connectToQuorumValidatorsInternal(
	signingSubnet ids.ID,
	quorumPercentage uint64,
) (*peers.ConnectedCanonicalValidators, error) {
	s.network.TrackSubnet(signingSubnet)

	var connectedValidators *peers.ConnectedCanonicalValidators
	var err error
	connectOp := func() error {
		connectedValidators, err = s.network.GetConnectedCanonicalValidators(signingSubnet)
		if err != nil {
			msg := "Failed to fetch connected canonical validators"
			s.logger.Error(
				msg,
				zap.Error(err),
			)
			s.metrics.FailuresToGetValidatorSet.Inc()
			return fmt.Errorf("%s: %w", msg, err)
		}
		s.metrics.ConnectedStakeWeightPercentage.WithLabelValues(
			signingSubnet.String(),
		).Set(
			float64(connectedValidators.ConnectedWeight) /
				float64(connectedValidators.ValidatorSet.TotalWeight) * 100,
		)
		if !utils.CheckStakeWeightExceedsThreshold(
			big.NewInt(0).SetUint64(connectedValidators.ConnectedWeight),
			connectedValidators.ValidatorSet.TotalWeight,
			quorumPercentage,
		) {
			s.logger.Warn(
				"Failed to connect to a threshold of stake",
				zap.Uint64("connectedWeight", connectedValidators.ConnectedWeight),
				zap.Uint64("totalValidatorWeight", connectedValidators.ValidatorSet.TotalWeight),
				zap.Uint64("quorumPercentage", quorumPercentage),
			)
			s.metrics.FailuresToConnectToSufficientStake.Inc()
			return errNotEnoughConnectedStake
		}
		return nil
	}
	err = utils.WithRetriesTimeout(s.logger, connectOp, connectToValidatorsTimeout)
	if err != nil {
		return nil, err
	}
	return connectedValidators, nil
}

// Get cached connected validators or connect to them if needed
func (s *SignatureAggregator) getConnectedValidators(
	signingSubnet ids.ID,
	quorumPercentage uint64,
) (*peers.ConnectedCanonicalValidators, error) {
	// First try to get from cache
	s.connectedValidatorsLock.RLock()
	connectedValidators, ok := s.connectedValidatorsMap[signingSubnet]
	s.connectedValidatorsLock.RUnlock()

	if ok {
		// Verify that we still have enough connected stake
		if utils.CheckStakeWeightExceedsThreshold(
			big.NewInt(0).SetUint64(connectedValidators.ConnectedWeight),
			connectedValidators.ValidatorSet.TotalWeight,
			quorumPercentage,
		) {
			return connectedValidators, nil
		}
		// Not enough connected stake, need to refresh
		s.logger.Info(
			"Cached validators no longer have sufficient stake, refreshing",
			zap.String("subnetID", signingSubnet.String()),
		)
	}

	// Not in cache or insufficient stake, create new connection
	newConnectedValidators, err := s.connectToQuorumValidatorsInternal(signingSubnet, quorumPercentage)
	if err != nil {
		return nil, err
	}

	// Update cache
	s.connectedValidatorsLock.Lock()
	s.connectedValidatorsMap[signingSubnet] = newConnectedValidators
	s.connectedValidatorsLock.Unlock()

	return newConnectedValidators, nil
}

func (s *SignatureAggregator) CreateSignedMessage(
	ctx context.Context,
	unsignedMessage *avalancheWarp.UnsignedMessage,
	justification []byte,
	inputSigningSubnet ids.ID,
	requiredQuorumPercentage uint64,
	quorumPercentageBuffer uint64,
) (*avalancheWarp.Message, error) {
	// Use default quorum parameters if not specified
	if requiredQuorumPercentage == 0 {
		requiredQuorumPercentage = s.defaultQuorumPercentage
	}
	if quorumPercentageBuffer == 0 {
		quorumPercentageBuffer = s.defaultQuorumPercentageBuffer
	}

	if requiredQuorumPercentage == 0 || requiredQuorumPercentage+quorumPercentageBuffer > 100 {
		s.logger.Error(
			"Invalid quorum percentages",
			zap.Uint64("requiredQuorumPercentage", requiredQuorumPercentage),
			zap.Uint64("quorumPercentageBuffer", quorumPercentageBuffer),
		)
		return nil, errInvalidQuorumPercentage
	}

	s.logger.Debug("Creating signed message", zap.String("warpMessageID", unsignedMessage.ID().String()))
	var signingSubnet ids.ID
	var err error
	// If signingSubnet is not set we default to the subnet of the source blockchain
	sourceSubnet, err := s.getSubnetID(unsignedMessage.SourceChainID)
	if err != nil {
		return nil, fmt.Errorf(
			"source message subnet not found for chainID %s",
			unsignedMessage.SourceChainID,
		)
	}
	if inputSigningSubnet == ids.Empty {
		signingSubnet = sourceSubnet
	} else {
		signingSubnet = inputSigningSubnet
	}
	s.logger.Debug(
		"Creating signed message with signing subnet",
		zap.String("warpMessageID", unsignedMessage.ID().String()),
		zap.Stringer("signingSubnet", signingSubnet),
	)

	connectedValidators, err := s.getConnectedValidators(signingSubnet, requiredQuorumPercentage)
	if err != nil {
		s.logger.Error(
			"Failed to fetch quorum of connected canonical validators",
			zap.Stringer("signingSubnet", signingSubnet),
			zap.Error(err),
		)
		return nil, err
	}

	isL1 := false
	if signingSubnet != constants.PrimaryNetworkID {
		subnet, err := s.GetSubnetCached(ctx, signingSubnet, s.pChainClientOptions...)
		if err != nil {
			s.logger.Error(
				"Failed to get subnet",
				zap.String("signingSubnetID", signingSubnet.String()),
				zap.Error(err),
			)
			return nil, err
		}
		isL1 = subnet.ConversionID != ids.Empty
	}

	// Tracks all collected signatures.
	// For L1s, we must take care to *not* include inactive validators in the signature map.
	// Inactive validator's stake weight still contributes to the total weight, but the verifying
	// node will not be able to verify the aggregate signature if it includes an inactive validator.
	signatureMap := make(map[int][bls.SignatureLen]byte)
	excludedValidators := set.NewSet[int](0)

	// Fetch L1 validators and find the node IDs with Balance = 0
	// Find the corresponding canonical validator set index for each of these, and add to the exclusion list
	// if ALL of the node IDs for a validator have Balance = 0
	if isL1 {
		s.logger.Debug("Checking L1 validators for zero balance nodes")
		l1Validators, err := s.GetCurrentL1ValidatorsCached(ctx, signingSubnet, s.pChainClientOptions...)
		if err != nil {
			s.logger.Error(
				"Failed to get L1 validators",
				zap.String("signingSubnetID", signingSubnet.String()),
				zap.Error(err),
			)
			return nil, err
		}

		// Set of unfunded L1 validator nodes
		unfundedNodes := set.NewSet[ids.NodeID](0)
		for _, validator := range l1Validators {
			if uint64(validator.Balance) < minimumL1ValidatorBalance {
				unfundedNodes.Add(validator.NodeID)
				s.logger.Debug(
					"Node has insufficient balance",
					zap.String("nodeID", validator.NodeID.String()),
					zap.Uint64("balance", uint64(validator.Balance)),
				)
			}
		}

		// Only exclude a canonical validator if all of its nodes are unfunded L1 validators.
		for i, validator := range connectedValidators.ValidatorSet.Validators {
			exclude := true
			for _, nodeID := range validator.NodeIDs {
				// This check will pass if either
				// 1) the node is an L1 validator with insufficient balance or
				// 2) the node is a non-L1 (legacy) validator
				if !unfundedNodes.Contains(nodeID) {
					exclude = false
					break
				}
			}
			if exclude {
				s.logger.Debug(
					"Excluding validator",
					zap.Any("nodeIDs", validator.NodeIDs),
				)
				excludedValidators.Add(i)
			}
		}
	}

	accumulatedSignatureWeight := big.NewInt(0)
	if cachedSignatures, ok := s.cache.Get(unsignedMessage.ID()); ok {
		for i, validator := range connectedValidators.ValidatorSet.Validators {
			cachedSignature, found := cachedSignatures[cache.PublicKeyBytes(validator.PublicKeyBytes)]
			// Do not include explicitly excluded validators in the aggregation
			if found && !excludedValidators.Contains(i) {
				signatureMap[i] = cachedSignature
				accumulatedSignatureWeight.Add(
					accumulatedSignatureWeight,
					new(big.Int).SetUint64(validator.Weight),
				)
			}
		}
		s.metrics.SignatureCacheHits.Add(float64(len(signatureMap)))
	}

	// Only return early if we have enough signatures to meet the quorum percentage
	// plus the buffer percentage.
	if signedMsg, err := s.aggregateIfSufficientWeight(
		unsignedMessage,
		signatureMap,
		accumulatedSignatureWeight,
		connectedValidators.ValidatorSet.TotalWeight,
		requiredQuorumPercentage+quorumPercentageBuffer,
	); err != nil {
		return nil, err
	} else if signedMsg != nil {
		return signedMsg, nil
	}
	if len(signatureMap) > 0 {
		s.metrics.SignatureCacheMisses.Add(float64(
			len(connectedValidators.ValidatorSet.Validators) - len(signatureMap),
		))
	}

	reqBytes, err := s.marshalRequest(unsignedMessage, justification, sourceSubnet)
	if err != nil {
		msg := "Failed to marshal request bytes"
		s.logger.Error(
			msg,
			zap.String("warpMessageID", unsignedMessage.ID().String()),
			zap.Error(err),
		)
		return nil, fmt.Errorf("%s: %w", msg, err)
	}

	// Construct the AppRequest
	requestID := s.currentRequestID.Add(1)
	outMsg, err := s.messageCreator.AppRequest(
		unsignedMessage.SourceChainID,
		requestID,
		utils.DefaultAppRequestTimeout,
		reqBytes,
	)
	if err != nil {
		msg := "Failed to create app request message"
		s.logger.Error(
			msg,
			zap.String("warpMessageID", unsignedMessage.ID().String()),
			zap.Error(err),
		)
		return nil, fmt.Errorf("%s: %w", msg, err)
	}

	var signedMsg *avalancheWarp.Message
	// Query the validators with retries. On each retry, query one node per unique BLS pubkey
	operation := func() error {
		responsesExpected := len(connectedValidators.ValidatorSet.Validators) - len(signatureMap)
		s.logger.Debug(
			"Aggregator collecting signatures from peers.",
			zap.String("sourceBlockchainID", unsignedMessage.SourceChainID.String()),
			zap.String("signingSubnetID", signingSubnet.String()),
			zap.Int("validatorSetSize", len(connectedValidators.ValidatorSet.Validators)),
			zap.Int("signatureMapSize", len(signatureMap)),
			zap.Int("responsesExpected", responsesExpected),
		)

		vdrSet := set.NewSet[ids.NodeID](len(connectedValidators.ValidatorSet.Validators))
		for i, vdr := range connectedValidators.ValidatorSet.Validators {
			// If we already have the signature for this validator, do not query any of the composite nodes again
			if _, ok := signatureMap[i]; ok {
				continue
			}

			// Add connected nodes to the request. We still query excludedValidators so that we may cache
			// their signatures for future requests.
			for _, nodeID := range vdr.NodeIDs {
				if connectedValidators.ConnectedNodes.Contains(nodeID) && !vdrSet.Contains(nodeID) {
					vdrSet.Add(nodeID)
					s.logger.Debug(
						"Added node ID to query.",
						zap.String("nodeID", nodeID.String()),
						zap.String("warpMessageID", unsignedMessage.ID().String()),
						zap.String("sourceBlockchainID", unsignedMessage.SourceChainID.String()),
					)
					// Register a timeout response for each queried node
					reqID := ids.RequestID{
						NodeID:    nodeID,
						ChainID:   unsignedMessage.SourceChainID,
						RequestID: requestID,
						Op:        byte(message.AppResponseOp),
					}
					s.network.RegisterAppRequest(reqID)
				}
			}
		}
		responseChan := s.network.RegisterRequestID(requestID, vdrSet.Len())

		sentTo := s.network.Send(outMsg, vdrSet, sourceSubnet, subnets.NoOpAllower)
		s.metrics.AppRequestCount.Inc()
		s.logger.Debug(
			"Sent signature request to network",
			zap.String("warpMessageID", unsignedMessage.ID().String()),
			zap.Any("sentTo", sentTo),
			zap.String("sourceBlockchainID", unsignedMessage.SourceChainID.String()),
			zap.String("sourceSubnetID", sourceSubnet.String()),
			zap.String("signingSubnetID", signingSubnet.String()),
		)
		for nodeID := range vdrSet {
			if !sentTo.Contains(nodeID) {
				s.logger.Warn(
					"Failed to make async request to node",
					zap.String("nodeID", nodeID.String()),
					zap.Error(err),
				)
				responsesExpected--
				s.metrics.FailuresSendingToNode.Inc()
			}
		}

		responseCount := 0
		if responsesExpected > 0 {
			for response := range responseChan {
				s.logger.Debug(
					"Processing response from node",
					zap.String("nodeID", response.NodeID().String()),
					zap.String("warpMessageID", unsignedMessage.ID().String()),
					zap.String("sourceBlockchainID", unsignedMessage.SourceChainID.String()),
				)
				var relevant bool
				signedMsg, relevant, err = s.handleResponse(
					response,
					sentTo,
					requestID,
					connectedValidators,
					unsignedMessage,
					signatureMap,
					excludedValidators,
					accumulatedSignatureWeight,
					requiredQuorumPercentage+quorumPercentageBuffer,
				)
				if err != nil {
					// don't increase node failures metric here, because we did
					// it in handleResponse
					return backoff.Permanent(fmt.Errorf(
						"failed to handle response: %w",
						err,
					))
				}
				if relevant {
					responseCount++
				}
				// If we have sufficient signatures, return here.
				if signedMsg != nil {
					s.logger.Info(
						"Created signed message.",
						zap.String("warpMessageID", unsignedMessage.ID().String()),
						zap.Uint64("signatureWeight", accumulatedSignatureWeight.Uint64()),
						zap.Uint64("totalValidatorWeight", connectedValidators.ValidatorSet.TotalWeight),
						zap.String("sourceBlockchainID", unsignedMessage.SourceChainID.String()),
					)
					return nil
				}
				// Break once we've had successful or unsuccessful responses from each requested node
				if responseCount == responsesExpected {
					break
				}
			}
		}

		// If we don't have enough signatures to represent the required quorum percentage plus the buffer
		// percentage after all the expected responses have been received, check if we have enough signatures
		// for just the required quorum percentage.
		signedMsg, err = s.aggregateIfSufficientWeight(
			unsignedMessage,
			signatureMap,
			accumulatedSignatureWeight,
			connectedValidators.ValidatorSet.TotalWeight,
			requiredQuorumPercentage,
		)
		if err != nil {
			return err
		}
		if signedMsg != nil {
			s.logger.Info(
				"Created signed message.",
				zap.String("warpMessageID", unsignedMessage.ID().String()),
				zap.Uint64("signatureWeight", accumulatedSignatureWeight.Uint64()),
				zap.Uint64("totalValidatorWeight", connectedValidators.ValidatorSet.TotalWeight),
				zap.String("sourceBlockchainID", unsignedMessage.SourceChainID.String()),
			)
			return nil
		}

		return errNotEnoughSignatures
	}

	err = utils.WithRetriesTimeout(s.logger, operation, signatureRequestTimeout)
	if err != nil {
		s.logger.Warn(
			"Failed to collect a threshold of signatures",
			zap.String("warpMessageID", unsignedMessage.ID().String()),
			zap.String("sourceBlockchainID", unsignedMessage.SourceChainID.String()),
			zap.Uint64("accumulatedWeight", accumulatedSignatureWeight.Uint64()),
			zap.Uint64("totalValidatorWeight", connectedValidators.ValidatorSet.TotalWeight),
			zap.Error(err),
		)
		return nil, errNotEnoughSignatures
	}
	return signedMsg, nil
}

func (s *SignatureAggregator) getSubnetID(blockchainID ids.ID) (ids.ID, error) {
	s.subnetsMapLock.RLock()
	subnetID, ok := s.subnetIDsByBlockchainID[blockchainID]
	s.subnetsMapLock.RUnlock()
	if ok {
		return subnetID, nil
	}
	s.logger.Info("Signing subnet not found, requesting from PChain", zap.String("blockchainID", blockchainID.String()))
	subnetID, err := s.network.GetSubnetID(blockchainID)
	if err != nil {
		return ids.ID{}, fmt.Errorf("source blockchain not found for chain ID %s", blockchainID)
	}
	s.setSubnetID(blockchainID, subnetID)
	return subnetID, nil
}

func (s *SignatureAggregator) setSubnetID(blockchainID ids.ID, subnetID ids.ID) {
	s.subnetsMapLock.Lock()
	s.subnetIDsByBlockchainID[blockchainID] = subnetID
	s.subnetsMapLock.Unlock()
}

// Attempts to create a signed Warp message from the accumulated responses.
// Returns a non-nil Warp message if [accumulatedSignatureWeight] exceeds the signature verification threshold.
// Returns false in the second return parameter if the app response is not relevant to the current signature
// aggregation request. Returns an error only if a non-recoverable error occurs, otherwise returns a nil error
// to continue processing responses.
func (s *SignatureAggregator) handleResponse(
	response message.InboundMessage,
	sentTo set.Set[ids.NodeID],
	requestID uint32,
	connectedValidators *peers.ConnectedCanonicalValidators,
	unsignedMessage *avalancheWarp.UnsignedMessage,
	signatureMap map[int][bls.SignatureLen]byte,
	excludedValidators set.Set[int],
	accumulatedSignatureWeight *big.Int,
	quorumPercentage uint64,
) (*avalancheWarp.Message, bool, error) {
	// Regardless of the response's relevance, call it's finished handler once this function returns
	defer response.OnFinishedHandling()

	// Check if this is an expected response.
	m := response.Message()
	rcvReqID, ok := message.GetRequestID(m)
	if !ok {
		// This should never occur, since inbound message validity is already checked by the inbound handler
		s.logger.Error("Could not get requestID from message")
		return nil, false, nil
	}
	nodeID := response.NodeID()
	if !sentTo.Contains(nodeID) || rcvReqID != requestID {
		s.logger.Debug("Skipping irrelevant app response")
		return nil, false, nil
	}

	// If we receive an AppRequestFailed, then the request timed out.
	// This is still a relevant response, since we are no longer expecting a response from that node.
	if response.Op() == message.AppErrorOp {
		s.logger.Debug("Request timed out")
		s.metrics.ValidatorTimeouts.Inc()
		return nil, true, nil
	}

	validator, vdrIndex := connectedValidators.GetValidator(nodeID)
	signature, valid := s.isValidSignatureResponse(unsignedMessage, response, validator.PublicKey)
	// Cache any valid signature, but only include in the aggregation if the validator is not explicitly
	// excluded, that way we can use the cached signature on future requests if the validator is
	// no longer excluded
	if valid {
		s.logger.Debug(
			"Got valid signature response",
			zap.String("nodeID", nodeID.String()),
			zap.Uint64("stakeWeight", validator.Weight),
			zap.String("warpMessageID", unsignedMessage.ID().String()),
			zap.String("sourceBlockchainID", unsignedMessage.SourceChainID.String()),
		)
		s.cache.Add(
			unsignedMessage.ID(),
			cache.PublicKeyBytes(validator.PublicKeyBytes),
			cache.SignatureBytes(signature),
		)
		if !excludedValidators.Contains(vdrIndex) {
			signatureMap[vdrIndex] = signature
			accumulatedSignatureWeight.Add(accumulatedSignatureWeight, new(big.Int).SetUint64(validator.Weight))
		}
	} else {
		s.logger.Debug(
			"Got invalid signature response",
			zap.String("nodeID", nodeID.String()),
			zap.Uint64("stakeWeight", validator.Weight),
			zap.String("warpMessageID", unsignedMessage.ID().String()),
			zap.String("sourceBlockchainID", unsignedMessage.SourceChainID.String()),
		)
		s.metrics.InvalidSignatureResponses.Inc()
		return nil, true, nil
	}

	if signedMsg, err := s.aggregateIfSufficientWeight(
		unsignedMessage,
		signatureMap,
		accumulatedSignatureWeight,
		connectedValidators.ValidatorSet.TotalWeight,
		quorumPercentage,
	); err != nil {
		return nil, true, err
	} else if signedMsg != nil {
		return signedMsg, true, nil
	}

	// Not enough signatures, continue processing messages
	return nil, true, nil
}

func (s *SignatureAggregator) aggregateIfSufficientWeight(
	unsignedMessage *avalancheWarp.UnsignedMessage,
	signatureMap map[int][bls.SignatureLen]byte,
	accumulatedSignatureWeight *big.Int,
	totalWeight uint64,
	quorumPercentage uint64,
) (*avalancheWarp.Message, error) {
	// As soon as the signatures exceed the stake weight threshold we try to aggregate and send the transaction.
	if !utils.CheckStakeWeightExceedsThreshold(
		accumulatedSignatureWeight,
		totalWeight,
		quorumPercentage,
	) {
		// Not enough signatures, continue processing messages
		return nil, nil
	}
	aggSig, vdrBitSet, err := s.aggregateSignatures(signatureMap)
	if err != nil {
		msg := "Failed to aggregate signature."
		s.logger.Error(
			msg,
			zap.String("sourceBlockchainID", unsignedMessage.SourceChainID.String()),
			zap.String("warpMessageID", unsignedMessage.ID().String()),
			zap.Error(err),
		)
		return nil, fmt.Errorf("%s: %w", msg, err)
	}

	signedMsg, err := avalancheWarp.NewMessage(
		unsignedMessage,
		&avalancheWarp.BitSetSignature{
			Signers:   vdrBitSet.Bytes(),
			Signature: *(*[bls.SignatureLen]byte)(bls.SignatureToBytes(aggSig)),
		},
	)
	if err != nil {
		msg := "Failed to create new signed message"
		s.logger.Error(
			msg,
			zap.String("sourceBlockchainID", unsignedMessage.SourceChainID.String()),
			zap.String("warpMessageID", unsignedMessage.ID().String()),
			zap.Error(err),
		)
		return nil, fmt.Errorf("%s: %w", msg, err)
	}
	return signedMsg, nil
}

// isValidSignatureResponse tries to generate a signature from the peer.AsyncResponse, then verifies
// the signature against the node's public key. If we are unable to generate the signature or verify
// correctly, false will be returned to indicate no valid signature was found in response.
func (s *SignatureAggregator) isValidSignatureResponse(
	unsignedMessage *avalancheWarp.UnsignedMessage,
	response message.InboundMessage,
	pubKey *bls.PublicKey,
) (blsSignatureBuf, bool) {
	// If the handler returned an error response, count the response and continue
	if response.Op() == message.AppErrorOp {
		s.logger.Debug(
			"Relayer async response failed",
			zap.String("nodeID", response.NodeID().String()),
		)
		return blsSignatureBuf{}, false
	}

	appResponse, ok := response.Message().(*p2p.AppResponse)
	if !ok {
		s.logger.Debug(
			"Relayer async response was not an AppResponse",
			zap.String("nodeID", response.NodeID().String()),
		)
		return blsSignatureBuf{}, false
	}

	signature, err := s.unmarshalResponse(appResponse.GetAppBytes())
	if err != nil {
		s.logger.Error(
			"Error unmarshaling signature response",
			zap.Error(err),
		)
	}

	// If the node returned an empty signature, then it has not yet seen the warp message. Retry later.
	emptySignature := blsSignatureBuf{}
	if bytes.Equal(signature[:], emptySignature[:]) {
		s.logger.Debug(
			"Response contained an empty signature",
			zap.String("nodeID", response.NodeID().String()),
		)
		return blsSignatureBuf{}, false
	}

	if len(signature) != bls.SignatureLen {
		s.logger.Debug(
			"Response signature has incorrect length",
			zap.Int("actual", len(signature)),
			zap.Int("expected", bls.SignatureLen),
		)
		return blsSignatureBuf{}, false
	}

	sig, err := bls.SignatureFromBytes(signature[:])
	if err != nil {
		s.logger.Debug(
			"Failed to create signature from response",
		)
		return blsSignatureBuf{}, false
	}

	if !bls.Verify(pubKey, sig, unsignedMessage.Bytes()) {
		s.logger.Debug(
			"Failed verification for signature",
			zap.String("pubKey", hex.EncodeToString(bls.PublicKeyToUncompressedBytes(pubKey))),
		)
		return blsSignatureBuf{}, false
	}

	return signature, true
}

// aggregateSignatures constructs a BLS aggregate signature from the collected validator signatures. Also
// returns a bit set representing the validators that are represented in the aggregate signature. The bit
// set is in canonical validator order.
func (s *SignatureAggregator) aggregateSignatures(
	signatureMap map[int][bls.SignatureLen]byte,
) (*bls.Signature, set.Bits, error) {
	// Aggregate the signatures
	signatures := make([]*bls.Signature, 0, len(signatureMap))
	vdrBitSet := set.NewBits()

	for i, sigBytes := range signatureMap {
		sig, err := bls.SignatureFromBytes(sigBytes[:])
		if err != nil {
			msg := "Failed to unmarshal signature"
			s.logger.Error(msg, zap.Error(err))
			return nil, set.Bits{}, fmt.Errorf("%s: %w", msg, err)
		}
		signatures = append(signatures, sig)
		vdrBitSet.Add(i)
	}

	aggSig, err := bls.AggregateSignatures(signatures)
	if err != nil {
		msg := "Failed to aggregate signatures"
		s.logger.Error(msg, zap.Error(err))
		return nil, set.Bits{}, fmt.Errorf("%s: %w", msg, err)
	}
	return aggSig, vdrBitSet, nil
}

func (s *SignatureAggregator) marshalRequest(
	unsignedMessage *avalancheWarp.UnsignedMessage,
	justification []byte,
	sourceSubnet ids.ID,
) ([]byte, error) {
	messageBytes, err := proto.Marshal(
		&sdk.SignatureRequest{
			Message:       unsignedMessage.Bytes(),
			Justification: justification,
		},
	)
	if err != nil {
		return nil, err
	}
	return networkP2P.PrefixMessage(
		networkP2P.ProtocolPrefix(networkP2P.SignatureRequestHandlerID),
		messageBytes,
	), nil
}

func (s *SignatureAggregator) unmarshalResponse(responseBytes []byte) (blsSignatureBuf, error) {
	// empty responses are valid and indicate the node has not seen the message
	if len(responseBytes) == 0 {
		return blsSignatureBuf{}, nil
	}
	var sigResponse sdk.SignatureResponse
	err := proto.Unmarshal(responseBytes, &sigResponse)
	if err != nil {
		return blsSignatureBuf{}, err
	}
	return blsSignatureBuf(sigResponse.Signature), nil
}

func (s *SignatureAggregator) GetCurrentL1ValidatorsCached(ctx context.Context, subnetID ids.ID, options ...rpc.Option) ([]platformvm.APIL1Validator, error) {
	s.l1ValidatorsCacheLock.RLock()
	l1Validators, ok := s.l1ValidatorsCache[subnetID]
	s.l1ValidatorsCacheLock.RUnlock()
	if ok {
		return l1Validators, nil
	}

	l1Validators, err := s.pChainClient.GetCurrentL1Validators(ctx, subnetID, nil, options...)
	if err != nil {
		return nil, err
	}
	s.l1ValidatorsCache[subnetID] = l1Validators
	return l1Validators, nil
}

func (s *SignatureAggregator) GetSubnetCached(ctx context.Context, subnetID ids.ID, options ...rpc.Option) (platformvm.GetSubnetClientResponse, error) {
	s.getSubnetCacheLock.RLock()
	subnet, ok := s.getSubnetCache[subnetID]
	s.getSubnetCacheLock.RUnlock()
	if ok {
		return subnet, nil
	}

	subnet, err := s.pChainClient.GetSubnet(ctx, subnetID, options...)
	if err != nil {
		return platformvm.GetSubnetClientResponse{}, err
	}
	s.getSubnetCache[subnetID] = subnet
	return subnet, nil
}

// --- Aggregator Wrapper ---

const (
	defaultAppTimeout     = 15 * time.Second // Timeout for each aggregation call
	defaultConnectTimeout = 10 * time.Second // Timeout for initial node info calls
)

type AggregatorWrapper struct {
	SigAgg          *SignatureAggregator
	SigningSubnetID ids.ID
}

const LOCAL_NODE_URL = "http://localhost:9650"

// NewAggregatorWrapper creates and initializes the necessary components
// for signature aggregation, returning a wrapper.
func NewAggregatorWrapper(signingSubnetID ids.ID) (*AggregatorWrapper, error) {
	// Use Background context for long-running network setup/info calls
	setupCtx, cancel := context.WithTimeout(context.Background(), defaultConnectTimeout)
	defer cancel()

	// --- Basic Setup ---
	logLevel := logging.Error // Or configure as needed
	logger := logging.NewLogger(
		"aggregator-wrapper",
		logging.NewWrappedCore(logLevel, os.Stdout, logging.JSON.ConsoleEncoder()),
	)
	networkLogger := logging.NewLogger(
		"p2p-network-wrapper",
		logging.NewWrappedCore(logLevel, os.Stdout, logging.JSON.ConsoleEncoder()),
	)

	// --- API Clients ---
	infoClient := info.NewClient(LOCAL_NODE_URL)
	pchainClient := platformvm.NewClient(LOCAL_NODE_URL)
	pchainRPCOptions := peerUtils.InitializeOptions(&basecfg.APIConfig{})

	// --- Get Local Node Info ---
	localNodeID, _, err := infoClient.GetNodeID(setupCtx)
	if err != nil {
		return nil, fmt.Errorf("failed to get local node ID: %w", err)
	}
	localNodeIP, err := infoClient.GetNodeIP(setupCtx)
	if err != nil {
		return nil, fmt.Errorf("failed to get local node IP: %w", err)
	}
	log.Printf("Using local node: ID=%s, IP=%s", localNodeID, localNodeIP)

	// --- Peer Network Setup ---
	peerCfg := &minimalPeerConfig{
		infoAPI:   &basecfg.APIConfig{BaseURL: LOCAL_NODE_URL},
		pchainAPI: &basecfg.APIConfig{BaseURL: LOCAL_NODE_URL},
	}
	registry := prometheus.NewRegistry() // Dummy registry for example
	trackedSubnets := set.NewSet[ids.ID](1)
	trackedSubnets.Add(signingSubnetID)
	manuallyTrackedPeers := []info.Peer{
		{Info: peer.Info{ID: localNodeID, PublicIP: localNodeIP}},
	}

	msgCreator, err := message.NewCreator(
		logger,
		registry,
		constants.DefaultNetworkCompressionType,
		constants.DefaultNetworkMaximumInboundTimeout,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create message creator: %w", err)
	}

	// Create the network; it will be managed internally by the aggregator
	network, err := peers.NewNetwork(
		networkLogger,
		registry,
		trackedSubnets,
		manuallyTrackedPeers,
		peerCfg,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create app request network: %w", err)
	}

	// Explicitly track the signing subnet (might be redundant if in initial set)
	network.TrackSubnet(signingSubnetID)

	log.Printf("Number of connected peers: %d", network.NumConnectedPeers())
	if network.NumConnectedPeers() == 0 {
		log.Println("WARN: No peers connected, signature aggregation might fail.")
	}

	// --- Signature Aggregator Setup ---
	sigAgg, err := NewSignatureAggregator(
		network, // Pass the created network here
		logger,
		msgCreator,
		1024, // Default cache size
		sigAggMetrics.NewSignatureAggregatorMetrics(registry),
		pchainClient,
		pchainRPCOptions,
	)
	if err != nil {
		// Even though we don't store the network ref, try to shut it down on error
		network.Shutdown()
		return nil, fmt.Errorf("failed to create signature aggregator: %w", err)
	}

	return &AggregatorWrapper{
		SigAgg:          sigAgg,
		SigningSubnetID: signingSubnetID,
	}, nil
}

// Sign uses the pre-configured aggregator to sign the message.
func (aw *AggregatorWrapper) Sign(ctx context.Context, unsignedMsg *avalancheWarp.UnsignedMessage) (*avalancheWarp.Message, error) {
	// Use a timeout specific to this aggregation call
	aggCtx, cancel := context.WithTimeout(ctx, defaultAppTimeout)
	defer cancel()

	// log.Printf("Calling CreateSignedMessage for Warp ID: %s", unsignedMsg.ID())
	signedMsg, err := aw.SigAgg.CreateSignedMessage(
		aggCtx,
		unsignedMsg,
		nil, // No justification
		aw.SigningSubnetID,
		0, // Use default quorum percentage
		0, // Use default quorum buffer
	)
	if err != nil {
		return nil, fmt.Errorf("signature aggregation failed for msg %s: %w", unsignedMsg.ID(), err)
	}
	// log.Printf("Successfully aggregated signature for msg %s", unsignedMsg.ID())
	return signedMsg, nil
}

// --- Minimal Config Implementation for Peers ---
type minimalPeerConfig struct {
	infoAPI   *basecfg.APIConfig
	pchainAPI *basecfg.APIConfig
}

func (m *minimalPeerConfig) GetInfoAPI() *basecfg.APIConfig     { return m.infoAPI }
func (m *minimalPeerConfig) GetPChainAPI() *basecfg.APIConfig   { return m.pchainAPI }
func (m *minimalPeerConfig) GetAllowPrivateIPs() bool           { return true }
func (m *minimalPeerConfig) GetTrackedSubnets() set.Set[ids.ID] { return set.NewSet[ids.ID](1) } // Minimal
func (m *minimalPeerConfig) GetTLSCert() *tls.Certificate       { return nil }
