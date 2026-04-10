package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"math/big"
	"net/netip"
	"os"
	"os/signal"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/ava-labs/avalanchego/api/info"
	"github.com/ava-labs/avalanchego/genesis"
	corethcore "github.com/ava-labs/avalanchego/graft/coreth/core"
	corethethclient "github.com/ava-labs/avalanchego/graft/coreth/ethclient"
	cparams "github.com/ava-labs/avalanchego/graft/coreth/params"
	"github.com/ava-labs/avalanchego/graft/coreth/plugin/evm/customtypes"
	"github.com/ava-labs/avalanchego/ids"
	"github.com/ava-labs/avalanchego/message"
	"github.com/ava-labs/avalanchego/network"
	avap2p "github.com/ava-labs/avalanchego/network/p2p"
	"github.com/ava-labs/avalanchego/proto/pb/p2p"
	"github.com/ava-labs/avalanchego/snow/engine/common"
	"github.com/ava-labs/avalanchego/snow/validators"
	"github.com/ava-labs/avalanchego/staking"
	"github.com/ava-labs/avalanchego/subnets"
	"github.com/ava-labs/avalanchego/utils/compression"
	avaconstants "github.com/ava-labs/avalanchego/utils/constants"
	"github.com/ava-labs/avalanchego/utils/logging"
	"github.com/ava-labs/avalanchego/utils/set"
	"github.com/ava-labs/avalanchego/version"
	"github.com/ava-labs/avalanchego/vms/platformvm"
	proposerblock "github.com/ava-labs/avalanchego/vms/proposervm/block"
	ethtypes "github.com/ava-labs/libevm/core/types"
	"github.com/ava-labs/libevm/rlp"

	"block_fetcher/executor"
	"block_fetcher/store"
)

const (
	defaultNodeURI       = "https://api.avax.network"
	defaultDBDir         = "data/mainnet-mdbx"
	defaultConnectWait   = 30 * time.Second
	defaultPeerWarmup    = 5 * time.Second
	defaultRequestWait   = 20 * time.Second
	defaultWriterBuffer  = 4096
	defaultBatchSize     = 256
	defaultExpectedNetID = uint32(1)
	defaultPrimarySubnet = "11111111111111111111111111111111LpoYY"
	defaultFixedTipBlock = uint64(1_000)
)

var (
	//go:embed utils/blockcontainerids/container_ids.json
	embeddedContainerIDs []byte
)

type permissiveValidatorManager struct {
	validators.Manager
}

func (*permissiveValidatorManager) Contains(ids.ID, ids.NodeID) bool {
	return true
}

type frontierResponse struct {
	nodeID      ids.NodeID
	requestID   uint32
	containerID ids.ID
}

type ancestorsResponse struct {
	nodeID    ids.NodeID
	requestID uint32
	blocks    [][]byte
}

type inboundHandler struct {
	connectedCh chan ids.NodeID
	frontierCh  chan frontierResponse
	ancestorsCh chan ancestorsResponse
	peers       set.Set[ids.NodeID]
	tracker     *avap2p.PeerTracker
}

func (h *inboundHandler) Connected(nodeID ids.NodeID, _ *version.Application, _ ids.ID) {
	if !h.peers.Contains(nodeID) {
		return
	}
	if h.tracker != nil {
		h.tracker.Connected(nodeID, nil)
	}
	select {
	case h.connectedCh <- nodeID:
	default:
	}
}

func (h *inboundHandler) Disconnected(nodeID ids.NodeID) {
	if h.tracker != nil {
		h.tracker.Disconnected(nodeID)
	}
}

func (h *inboundHandler) HandleInbound(_ context.Context, msg *message.InboundMessage) {
	defer msg.OnFinishedHandling()

	switch msg.Op {
	case message.AcceptedFrontierOp:
		payload, ok := msg.Message.(*p2p.AcceptedFrontier)
		if !ok {
			return
		}
		containerID, err := ids.ToID(payload.ContainerId)
		if err != nil {
			return
		}
		select {
		case h.frontierCh <- frontierResponse{
			nodeID:      msg.NodeID,
			requestID:   payload.RequestId,
			containerID: containerID,
		}:
		default:
		}
	case message.AncestorsOp:
		payload, ok := msg.Message.(*p2p.Ancestors)
		if !ok {
			return
		}
		select {
		case h.ancestorsCh <- ancestorsResponse{
			nodeID:    msg.NodeID,
			requestID: payload.RequestId,
			blocks:    payload.Containers,
		}:
		default:
		}
	}
}

type blockMeta struct {
	parentID ids.ID
}

type containerRecord struct {
	outerID     ids.ID
	parentID    ids.ID
	innerHash   ids.ID
	innerNumber uint64
	txCount     int
	raw         []byte
}

type writerStats struct {
	stored uint64
}

func main() {
	cparams.RegisterExtras()
	customtypes.Register()

	var (
		nodeURI      = flag.String("node-uri", defaultNodeURI, "base AvalancheGo URI for local RPC discovery")
		dbDir        = flag.String("db-dir", defaultDBDir, "MDBX database directory")
		connectWait  = flag.Duration("connect-timeout", defaultConnectWait, "time to wait for a validator peer connection")
		peerWarmup   = flag.Duration("peer-warmup", defaultPeerWarmup, "extra time to gather more connected peers before fetching")
		requestWait  = flag.Duration("request-timeout", defaultRequestWait, "time to wait for each P2P response")
		writerBuffer = flag.Int("writer-buffer", defaultWriterBuffer, "number of fetched containers to buffer before blocking")
		batchSize    = flag.Int("batch-size", defaultBatchSize, "number of containers per MDBX batch")
		expectedNet  = flag.Uint("expected-network-id", uint(defaultExpectedNetID), "expected Avalanche network ID")
		subnetIDStr  = flag.String("subnet-id", defaultPrimarySubnet, "subnet ID for platform.getCurrentValidators")
		cleanState   = flag.Bool("clean-state", false, "clear all state tables (keep blocks) and re-execute from genesis")
	)
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if *writerBuffer <= 0 {
		log.Fatalf("writer-buffer must be > 0")
	}
	if *batchSize <= 0 {
		log.Fatalf("batch-size must be > 0")
	}

	db, err := store.Open(*dbDir)
	if err != nil {
		log.Fatalf("open MDBX: %v", err)
	}
	defer db.Close()

	if *cleanState {
		log.Printf("clearing state tables (keeping blocks)...")
		if err := db.ClearState(); err != nil {
			log.Fatalf("clear state: %v", err)
		}
		log.Printf("state cleared")
	}

	writerCh := make(chan []byte, *writerBuffer)
	writerErrCh := make(chan error, 1)
	go func() {
		writerErrCh <- runWriter(ctx, db, writerCh, *batchSize)
	}()

	executorStopAt := make(chan uint64, 1)
	executorErrCh := make(chan error, 1)
	go func() {
		executorErrCh <- runExecutor(ctx, db, executorStopAt)
	}()

	subnetID, err := ids.FromString(*subnetIDStr)
	if err != nil {
		log.Fatalf("invalid subnet-id: %v", err)
	}

	infoClient := info.NewClient(*nodeURI)
	pClient := platformvm.NewClient(*nodeURI)

	networkID, err := infoClient.GetNetworkID(ctx)
	if err != nil {
		log.Fatalf("info.getNetworkID: %v", err)
	}
	if *expectedNet > 0 && networkID != uint32(*expectedNet) {
		log.Fatalf("unexpected network ID: got=%d want=%d", networkID, *expectedNet)
	}
	chainID, err := infoClient.GetBlockchainID(ctx, "C")
	if err != nil {
		log.Fatalf("info.getBlockchainID(C): %v", err)
	}
	log.Printf("network info: network_id=%d chain_id=%s", networkID, chainID)

	validatorIDs, err := loadValidatorIDs(ctx, pClient, subnetID)
	if err != nil {
		log.Fatalf("platform.getCurrentValidators: %v", err)
	}
	log.Printf("validator set loaded: count=%d", len(validatorIDs))

	peerInfos, validatorOnly, err := discoverPeers(ctx, infoClient, validatorIDs)
	if err != nil {
		log.Fatalf("discover peers: %v", err)
	}
	if len(peerInfos) == 0 {
		log.Fatalf("no peers available from info.peers")
	}
	log.Printf("peer candidates loaded: count=%d validator_only=%t", len(peerInfos), validatorOnly)

	peerIDs := set.NewSet[ids.NodeID](len(peerInfos))
	for _, peerInfo := range peerInfos {
		peerIDs.Add(peerInfo.ID)
	}
	peerTracker, err := avap2p.NewPeerTracker(
		logging.NoLog{},
		"block_fetcher",
		prometheus.NewRegistry(),
		set.Set[ids.NodeID]{},
		nil,
	)
	if err != nil {
		log.Fatalf("NewPeerTracker: %v", err)
	}

	handler := &inboundHandler{
		connectedCh: make(chan ids.NodeID, len(peerInfos)+4),
		frontierCh:  make(chan frontierResponse, 4),
		ancestorsCh: make(chan ancestorsResponse, 8),
		peers:       peerIDs,
		tracker:     peerTracker,
	}

	vdrs := &permissiveValidatorManager{
		Manager: validators.NewManager(),
	}
	cfg, err := network.NewTestNetworkConfig(
		prometheus.NewRegistry(),
		networkID,
		vdrs,
		set.Set[ids.ID]{},
	)
	if err != nil {
		log.Fatalf("NewTestNetworkConfig: %v", err)
	}
	stakingCert, err := staking.ParseCertificate(cfg.TLSConfig.Certificates[0].Leaf.Raw)
	if err != nil {
		log.Fatalf("ParseCertificate: %v", err)
	}
	cfg.MyNodeID = ids.NodeIDFromCert(stakingCert)

	net, err := network.NewTestNetwork(
		logging.NoLog{},
		prometheus.NewRegistry(),
		cfg,
		handler,
	)
	if err != nil {
		log.Fatalf("NewTestNetwork: %v", err)
	}
	defer net.StartClose()

	dispatchErrCh := make(chan error, 1)
	go func() {
		dispatchErrCh <- net.Dispatch()
	}()

	for _, peerInfo := range peerInfos {
		net.ManuallyTrack(peerInfo.ID, peerAddr(peerInfo))
	}

	connected, err := waitForConnectedPeer(ctx, dispatchErrCh, handler.connectedCh, peerIDs, *connectWait)
	if err != nil {
		log.Fatalf("connect peer: %v", err)
	}
	log.Printf("connected peer: %s", connected)
	if *peerWarmup > 0 {
		connectedCount := warmupPeers(ctx, dispatchErrCh, handler.connectedCh, peerIDs, *peerWarmup)
		log.Printf("peer warmup complete: connected=%d window=%s", connectedCount, peerWarmup.String())
	}

	msgCreator, err := message.NewCreator(
		prometheus.NewRegistry(),
		compression.TypeZstd,
		avaconstants.DefaultNetworkMaximumInboundTimeout,
	)
	if err != nil {
		log.Fatalf("NewCreator: %v", err)
	}

	var (
		tipID        ids.ID
		frontierPeer ids.NodeID
		nextID       ids.ID
		requestID    uint32 = 1
	)
	tipID, err = loadEmbeddedContainerID(defaultFixedTipBlock)
	if err != nil {
		log.Fatalf("load fixed tip container: %v", err)
	}
	log.Printf("using fixed tip container: blockID=%s block_number=%d", tipID, defaultFixedTipBlock)
	nextID = tipID

	started := time.Now()
	var (
		totalBlocks int
	)

	for {
		select {
		case <-ctx.Done():
			close(writerCh)
			if err := <-writerErrCh; err != nil {
				log.Fatalf("writer failed: %v", err)
			}
			elapsed := time.Since(started)
			log.Printf(
				"stopped fetched=%d peer=%s tip_block=%s elapsed=%s blocks_per_sec=%.2f",
				totalBlocks,
				frontierPeer,
				tipID,
				elapsed.Truncate(time.Millisecond),
				float64(totalBlocks)/elapsed.Seconds(),
			)
			return
		case err := <-writerErrCh:
			if err != nil {
				log.Fatalf("writer failed: %v", err)
			}
			log.Fatalf("writer stopped unexpectedly")
		case err := <-executorErrCh:
			if err != nil {
				log.Fatalf("executor failed: %v", err)
			}
			log.Fatalf("executor stopped unexpectedly")
		default:
		}

		if nextID == ids.Empty {
			close(writerCh)
			if err := <-writerErrCh; err != nil {
				log.Fatalf("writer failed: %v", err)
			}
			elapsed := time.Since(started)
			log.Printf(
				"reached genesis fetched=%d tip_block=%s elapsed=%s blocks_per_sec=%.2f",
				totalBlocks,
				tipID,
				elapsed.Truncate(time.Millisecond),
				float64(totalBlocks)/elapsed.Seconds(),
			)
			// Tell executor the max block number and wait.
			executorStopAt <- defaultFixedTipBlock
			log.Printf("waiting for executor to finish processing up to block %d...", defaultFixedTipBlock)
			if err := <-executorErrCh; err != nil {
				log.Fatalf("executor failed: %v", err)
			}
			return
		}

		if storedParentID, ok, err := loadStoredParentID(nextID); err != nil {
			log.Fatalf("load stored parent for %s: %v", nextID, err)
		} else if ok {
			totalBlocks++
			nextID = storedParentID
			continue
		}

		resp, peerID, err := fetchAncestors(ctx, dispatchErrCh, net, msgCreator, chainID, peerTracker, requestID, nextID, *requestWait, handler.ancestorsCh)
		if err != nil {
			log.Printf("fetch ancestors request_id=%d failed: %v", requestID, err)
			requestID++
			continue
		}
		requestID++

		if len(resp.blocks) == 0 {
			peerTracker.RegisterFailure(peerID)
			continue
		}

		consume := len(resp.blocks)

		var oldestMeta blockMeta
		batchValid := true
		for i := 0; i < consume; i++ {
			raw := append([]byte(nil), resp.blocks[i]...)
			if len(raw) == 0 {
				peerTracker.RegisterFailure(peerID)
				batchValid = false
				break
			}
			meta, err := parseBlockMeta(raw)
			if err != nil {
				log.Printf("discarding batch request_id=%d peer=%s: parse block %d/%d failed: bytes=%d err=%v", resp.requestID, peerID, i, consume, len(raw), err)
				peerTracker.RegisterFailure(peerID)
				batchValid = false
				break
			}
			select {
			case writerCh <- raw:
			case err := <-writerErrCh:
				if err != nil {
					log.Fatalf("writer failed: %v", err)
				}
				log.Fatalf("writer stopped unexpectedly")
			case <-ctx.Done():
				log.Fatalf("context canceled while enqueueing container: %v", ctx.Err())
			}
			oldestMeta = meta
		}
		if !batchValid {
			continue
		}

		totalBlocks += consume
		log.Printf(
			"batch request_id=%d peer=%s blocks=%d consumed=%d total=%d next_parent=%s",
			resp.requestID,
			peerID,
			len(resp.blocks),
			consume,
			totalBlocks,
			oldestMeta.parentID,
		)

		nextID = oldestMeta.parentID
	}
}

func loadEmbeddedContainerID(blockNum uint64) (ids.ID, error) {
	var containerIDs map[string]string
	if err := json.Unmarshal(embeddedContainerIDs, &containerIDs); err != nil {
		return ids.Empty, fmt.Errorf("decode embedded container ids: %w", err)
	}

	key := strconv.FormatUint(blockNum, 10)
	containerID, ok := containerIDs[key]
	if !ok {
		return ids.Empty, fmt.Errorf("missing embedded container id for block %s", key)
	}
	return ids.FromString(containerID)
}

func loadValidatorIDs(
	ctx context.Context,
	client *platformvm.Client,
	subnetID ids.ID,
) ([]ids.NodeID, error) {
	validatorsList, err := client.GetCurrentValidators(ctx, subnetID, nil)
	if err != nil {
		return nil, err
	}
	nodeIDs := make([]ids.NodeID, 0, len(validatorsList))
	seen := set.NewSet[ids.NodeID](len(validatorsList))
	for _, validator := range validatorsList {
		if seen.Contains(validator.NodeID) {
			continue
		}
		seen.Add(validator.NodeID)
		nodeIDs = append(nodeIDs, validator.NodeID)
	}
	sort.Slice(nodeIDs, func(i, j int) bool {
		return nodeIDs[i].String() < nodeIDs[j].String()
	})
	return nodeIDs, nil
}

func discoverPeers(
	ctx context.Context,
	client *info.Client,
	validatorIDs []ids.NodeID,
) ([]info.Peer, bool, error) {
	if len(validatorIDs) > 0 {
		peers, err := client.Peers(ctx, validatorIDs)
		if err == nil && len(peers) > 0 {
			sortPeers(peers)
			return peers, true, nil
		}
	}

	peers, err := client.Peers(ctx, nil)
	if err != nil {
		return nil, false, err
	}
	sortPeers(peers)
	return peers, false, nil
}

func sortPeers(peers []info.Peer) {
	sort.Slice(peers, func(i, j int) bool {
		return peers[i].ID.String() < peers[j].ID.String()
	})
}

func peerAddr(peerInfo info.Peer) netip.AddrPort {
	if peerInfo.PublicIP.IsValid() {
		return peerInfo.PublicIP
	}
	return peerInfo.IP
}

func waitForConnectedPeer(
	ctx context.Context,
	dispatchErrCh <-chan error,
	connectedCh <-chan ids.NodeID,
	allowed set.Set[ids.NodeID],
	timeout time.Duration,
) (ids.NodeID, error) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	for {
		select {
		case <-ctx.Done():
			return ids.EmptyNodeID, ctx.Err()
		case err := <-dispatchErrCh:
			return ids.EmptyNodeID, fmt.Errorf("network stopped: %w", err)
		case <-timer.C:
			return ids.EmptyNodeID, fmt.Errorf("timed out waiting for peer connection after %s", timeout)
		case nodeID := <-connectedCh:
			if allowed.Contains(nodeID) {
				return nodeID, nil
			}
		}
	}
}

func warmupPeers(
	ctx context.Context,
	dispatchErrCh <-chan error,
	connectedCh <-chan ids.NodeID,
	allowed set.Set[ids.NodeID],
	window time.Duration,
) int {
	timer := time.NewTimer(window)
	defer timer.Stop()

	seen := set.NewSet[ids.NodeID](0)
	for {
		select {
		case <-ctx.Done():
			return seen.Len()
		case <-timer.C:
			return seen.Len()
		case <-dispatchErrCh:
			return seen.Len()
		case nodeID := <-connectedCh:
			if allowed.Contains(nodeID) {
				seen.Add(nodeID)
			}
		}
	}
}

func fetchAcceptedFrontier(
	ctx context.Context,
	dispatchErrCh <-chan error,
	net network.Network,
	msgCreator message.Creator,
	chainID ids.ID,
	peerTracker *avap2p.PeerTracker,
	requestID uint32,
	timeout time.Duration,
	frontierCh <-chan frontierResponse,
) (ids.ID, ids.NodeID, error) {
	peerID, ok := peerTracker.SelectPeer()
	if !ok {
		return ids.Empty, ids.EmptyNodeID, fmt.Errorf("no connected peers available for accepted frontier")
	}
	peerTracker.RegisterRequest(peerID)
	started := time.Now()

	outMsg, err := msgCreator.GetAcceptedFrontier(chainID, requestID, timeout)
	if err != nil {
		return ids.Empty, ids.EmptyNodeID, err
	}
	net.Send(
		outMsg,
		common.SendConfig{NodeIDs: set.Of(peerID)},
		avaconstants.PrimaryNetworkID,
		subnets.NoOpAllower,
	)

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	for {
		select {
		case <-ctx.Done():
			return ids.Empty, ids.EmptyNodeID, ctx.Err()
		case err := <-dispatchErrCh:
			return ids.Empty, ids.EmptyNodeID, fmt.Errorf("network stopped: %w", err)
		case <-timer.C:
			peerTracker.RegisterFailure(peerID)
			return ids.Empty, ids.EmptyNodeID, fmt.Errorf("timed out waiting for accepted frontier from %s", peerID)
		case resp := <-frontierCh:
			if resp.nodeID == peerID && resp.requestID == requestID {
				elapsed := time.Since(started).Seconds()
				if elapsed <= 0 {
					elapsed = 1e-9
				}
				peerTracker.RegisterResponse(peerID, 1/elapsed)
				return resp.containerID, peerID, nil
			}
		}
	}
}

func fetchAncestors(
	ctx context.Context,
	dispatchErrCh <-chan error,
	net network.Network,
	msgCreator message.Creator,
	chainID ids.ID,
	peerTracker *avap2p.PeerTracker,
	requestID uint32,
	blockID ids.ID,
	timeout time.Duration,
	ancestorsCh <-chan ancestorsResponse,
) (ancestorsResponse, ids.NodeID, error) {
	peerID, ok := peerTracker.SelectPeer()
	if !ok {
		return ancestorsResponse{}, ids.EmptyNodeID, fmt.Errorf("no connected peers available for ancestors")
	}
	peerTracker.RegisterRequest(peerID)
	started := time.Now()

	outMsg, err := msgCreator.GetAncestors(
		chainID,
		requestID,
		timeout,
		blockID,
		p2p.EngineType_ENGINE_TYPE_CHAIN,
	)
	if err != nil {
		return ancestorsResponse{}, ids.EmptyNodeID, err
	}
	net.Send(
		outMsg,
		common.SendConfig{NodeIDs: set.Of(peerID)},
		avaconstants.PrimaryNetworkID,
		subnets.NoOpAllower,
	)

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	for {
		select {
		case <-ctx.Done():
			return ancestorsResponse{}, ids.EmptyNodeID, ctx.Err()
		case err := <-dispatchErrCh:
			return ancestorsResponse{}, ids.EmptyNodeID, fmt.Errorf("network stopped: %w", err)
		case <-timer.C:
			peerTracker.RegisterFailure(peerID)
			return ancestorsResponse{}, ids.EmptyNodeID, fmt.Errorf("timed out waiting for ancestors from %s for %s", peerID, blockID)
		case resp := <-ancestorsCh:
			if resp.nodeID == peerID && resp.requestID == requestID {
				numBytes := 0
				for _, blk := range resp.blocks {
					numBytes += len(blk)
				}
				if numBytes > 0 {
					elapsed := time.Since(started).Seconds()
					if elapsed <= 0 {
						elapsed = 1e-9
					}
					peerTracker.RegisterResponse(peerID, float64(numBytes)/elapsed)
				} else {
					peerTracker.RegisterFailure(peerID)
				}
				return resp, peerID, nil
			}
		}
	}
}

func parseBlockMeta(raw []byte) (blockMeta, error) {
	if proposerBlk, err := proposerblock.ParseWithoutVerification(raw); err == nil {
		return blockMeta{
			parentID: proposerBlk.ParentID(),
		}, nil
	}

	ethBlock, _, err := parsePreForkEthBlock(raw)
	if err != nil {
		return blockMeta{}, fmt.Errorf("block is neither proposer nor pre-fork coreth: %w", err)
	}
	return blockMeta{
		parentID: ids.ID(ethBlock.ParentHash()),
	}, nil
}

func parseContainerRecord(raw []byte) (*containerRecord, error) {
	proposerBlk, err := proposerblock.ParseWithoutVerification(raw)
	if err != nil {
		ethBlock, rawBlock, rawErr := parsePreForkEthBlock(raw)
		if rawErr != nil {
			return nil, fmt.Errorf("parse proposer block: %w", err)
		}
		return &containerRecord{
			outerID:     ids.ID(ethBlock.Hash()),
			parentID:    ids.ID(ethBlock.ParentHash()),
			innerHash:   ids.ID(ethBlock.Hash()),
			innerNumber: ethBlock.NumberU64(),
			txCount:     len(ethBlock.Transactions()),
			raw:         rawBlock,
		}, nil
	}
	ethBlock := new(ethtypes.Block)
	if err := rlp.DecodeBytes(proposerBlk.Block(), ethBlock); err != nil {
		return nil, fmt.Errorf("decode inner eth block: %w", err)
	}
	return &containerRecord{
		outerID:     proposerBlk.ID(),
		parentID:    proposerBlk.ParentID(),
		innerHash:   ids.ID(ethBlock.Hash()),
		innerNumber: ethBlock.NumberU64(),
		txCount:     len(ethBlock.Transactions()),
		raw:         raw,
	}, nil
}

func parsePreForkEthBlock(raw []byte) (*ethtypes.Block, []byte, error) {
	_, _, rest, err := rlp.Split(raw)
	if err != nil {
		return nil, nil, err
	}
	rawBlock := raw[:len(raw)-len(rest)]

	ethBlock := new(ethtypes.Block)
	if err := rlp.DecodeBytes(rawBlock, ethBlock); err != nil {
		return nil, nil, err
	}
	return ethBlock, rawBlock, nil
}

func runWriter(
	ctx context.Context,
	db *store.DB,
	input <-chan []byte,
	batchSize int,
) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	var pending []containerRecord
	stored := uint64(0)

	flush := func() error {
		if len(pending) == 0 {
			return nil
		}
		tx, err := db.BeginRW()
		if err != nil {
			return fmt.Errorf("begin RW txn: %w", err)
		}
		var maxNum uint64
		for _, rec := range pending {
			if err := store.PutBlock(tx, db, rec.innerNumber, [32]byte(rec.innerHash), rec.raw); err != nil {
				tx.Abort()
				return fmt.Errorf("put block %d: %w", rec.innerNumber, err)
			}
			if rec.innerNumber > maxNum {
				maxNum = rec.innerNumber
			}
		}
		// Update latest stored block if we have a new max.
		latestStored, ok := store.GetLatestStoredBlock(tx, db)
		if !ok || maxNum > latestStored {
			if err := store.SetLatestStoredBlock(tx, db, maxNum); err != nil {
				tx.Abort()
				return fmt.Errorf("set latest stored block: %w", err)
			}
		}
		if _, err := tx.Commit(); err != nil {
			return fmt.Errorf("commit writer txn: %w", err)
		}
		stored += uint64(len(pending))
		if stored%1000 < uint64(len(pending)) {
			log.Printf("writer stored=%d", stored)
		}
		pending = pending[:0]
		return nil
	}

	for {
		select {
		case <-ctx.Done():
			return flush()
		case raw, ok := <-input:
			if !ok {
				return flush()
			}
			rec, err := parseContainerRecord(raw)
			if err != nil {
				return err
			}
			pending = append(pending, *rec)
			if len(pending) >= batchSize {
				if err := flush(); err != nil {
					return err
				}
			}
		case <-ticker.C:
			if err := flush(); err != nil {
				return err
			}
		}
	}
}

func runExecutor(ctx context.Context, db *store.DB, stopAt <-chan uint64) error {
	config := genesis.GetConfig(avaconstants.MainnetID)
	var cChainGenesis corethcore.Genesis
	if err := json.Unmarshal([]byte(config.CChainGenesis), &cChainGenesis); err != nil {
		return fmt.Errorf("parse C-Chain genesis config: %w", err)
	}
	chainCfg := cChainGenesis.Config

	// Load genesis if needed.
	roTx, err := db.BeginRO()
	if err != nil {
		return err
	}
	loaded, err := executor.IsGenesisLoaded(roTx, db)
	roTx.Abort()
	if err != nil {
		return err
	}
	if !loaded {
		log.Printf("executor: loading genesis state...")
		rwTx, err := db.BeginRW()
		if err != nil {
			return err
		}
		if err := executor.LoadGenesis(rwTx, db); err != nil {
			rwTx.Abort()
			return err
		}
		if _, err := rwTx.Commit(); err != nil {
			return err
		}
		log.Printf("executor: genesis state loaded")
	}

	// Resume from last executed block.
	roTx, err = db.BeginRO()
	if err != nil {
		return err
	}
	headBlock, hasHead := store.GetHeadBlock(roTx, db)
	roTx.Abort()

	nextBlock := uint64(1)
	if hasHead {
		nextBlock = headBlock + 1
	}

	exec := executor.NewExecutor(db, chainCfg)
	var maxBlock uint64

	for {
		if ctx.Err() != nil {
			return nil
		}

		// Check if we've been told to stop at a certain block.
		select {
		case mb := <-stopAt:
			maxBlock = mb
		default:
		}
		if maxBlock > 0 && nextBlock > maxBlock {
			log.Printf("executor: finished all blocks up to %d", maxBlock)
			return nil
		}

		// Try to get the next block. If not there, wait 100ms.
		roTx, err := db.BeginRO()
		if err != nil {
			return err
		}
		_, err = store.GetBlockByNumber(roTx, db, nextBlock)
		roTx.Abort()

		if err != nil {
			time.Sleep(100 * time.Millisecond)
			continue
		}

		if err := exec.ProcessBlock(nextBlock); err != nil {
			return fmt.Errorf("block %d: %w", nextBlock, err)
		}

		if nextBlock%100 == 0 {
			log.Printf("executor: processed block %d", nextBlock)
		}
		nextBlock++
	}
}

func verifyLatestBlocks(ctx context.Context, db *store.DB, nodeURI string, samples int) error {
	rpcURL := cChainRPCURL(nodeURI)
	client, err := corethethclient.DialContext(ctx, rpcURL)
	if err != nil {
		return fmt.Errorf("dial c-chain rpc: %w", err)
	}
	defer client.Close()

	roTx, err := db.BeginRO()
	if err != nil {
		return fmt.Errorf("begin RO txn: %w", err)
	}
	defer roTx.Abort()

	latestStored, ok := store.GetLatestStoredBlock(roTx, db)
	if !ok {
		return errors.New("no persisted blocks to verify")
	}

	count := 0
	for num := latestStored; num > 0 && count < samples; num-- {
		raw, err := store.GetBlockByNumber(roTx, db, num)
		if err != nil {
			continue
		}
		rec, err := parseContainerRecord(append([]byte(nil), raw...))
		if err != nil {
			return err
		}

		rpcBlock, err := client.BlockByNumber(ctx, new(big.Int).SetUint64(num))
		if err != nil {
			return fmt.Errorf("rpc block %d: %w", num, err)
		}
		if ids.ID(rpcBlock.Hash()) != rec.innerHash {
			return fmt.Errorf("block %d hash mismatch: stored=%s rpc=%s", num, rec.innerHash, rpcBlock.Hash())
		}
		if len(rpcBlock.Transactions()) != rec.txCount {
			return fmt.Errorf("block %d tx count mismatch: stored=%d rpc=%d", num, rec.txCount, len(rpcBlock.Transactions()))
		}
		log.Printf("verified block number=%d outer=%s inner=%s txs=%d", num, rec.outerID, rec.innerHash, rec.txCount)
		count++
	}
	if count == 0 {
		return errors.New("no persisted blocks to verify")
	}
	return nil
}

func cChainRPCURL(nodeURI string) string {
	return strings.TrimRight(nodeURI, "/") + "/ext/bc/C/rpc"
}

// loadStoredParentID is no longer backed by a persistent index.
// We always return false so the fetcher re-fetches blocks it has already seen.
// This is acceptable since MDBX PutBlock is idempotent.
func loadStoredParentID(containerID ids.ID) (ids.ID, bool, error) {
	_ = containerID
	return ids.Empty, false, nil
}
