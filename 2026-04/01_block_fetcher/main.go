package main

import (
	"context"
	_ "embed"
	"encoding/binary"
	"encoding/json"
	"net/http"
	_ "net/http/pprof"
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
	"github.com/ava-labs/avalanchego/graft/coreth/core/extstate"
	corethethclient "github.com/ava-labs/avalanchego/graft/coreth/ethclient"
	cparams "github.com/ava-labs/avalanchego/graft/coreth/params"
	"github.com/ava-labs/avalanchego/graft/coreth/plugin/evm/atomic"
	ccustomtypes "github.com/ava-labs/avalanchego/graft/coreth/plugin/evm/customtypes"
	"github.com/ava-labs/avalanchego/ids"
	"github.com/ava-labs/avalanchego/message"
	"github.com/ava-labs/avalanchego/network"
	avap2p "github.com/ava-labs/avalanchego/network/p2p"
	"github.com/ava-labs/avalanchego/proto/pb/p2p"
	"github.com/ava-labs/avalanchego/snow"
	avacommon "github.com/ava-labs/avalanchego/snow/engine/common"
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
	"github.com/ava-labs/libevm/common"
	"github.com/ava-labs/libevm/core/state"
	ethtypes "github.com/ava-labs/libevm/core/types"
	"github.com/ava-labs/libevm/core/vm"
	"github.com/ava-labs/libevm/crypto"
	"github.com/ava-labs/libevm/params"
	"github.com/ava-labs/libevm/rlp"
	"github.com/holiman/uint256"

	"block_fetcher/statetrie"
	"block_fetcher/store"
	intTrie "block_fetcher/trie"

	"github.com/erigontech/mdbx-go/mdbx"
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
	defaultFixedTipBlock = uint64(1_000_000)
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
	// pprof server for profiling
	go func() {
		log.Println("pprof listening on :6060")
		log.Println(http.ListenAndServe(":6060", nil))
	}()

	corethcore.RegisterExtras()
	ccustomtypes.Register()
	extstate.RegisterExtras()
	cparams.RegisterExtras()

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
		cleanState     = flag.Bool("clean-state", false, "clear all state tables (keep blocks) and re-execute from genesis")
		verifyEvery    = flag.Uint64("verify-interval", 0, "verify state root every N blocks (0=every block)")
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
		executorErrCh <- runExecutor(ctx, db, executorStopAt, *verifyEvery)
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
		avacommon.SendConfig{NodeIDs: set.Of(peerID)},
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
		avacommon.SendConfig{NodeIDs: set.Of(peerID)},
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
			if err := store.PutContainer(tx, db, [32]byte(rec.outerID), rec.innerNumber, rec.raw); err != nil {
				tx.Abort()
				return fmt.Errorf("put container %d: %w", rec.innerNumber, err)
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

const MainnetAVAXAssetID = "FvwEAhmxKfeiG8SnEvq42hc6whRyY3EFYAvebMqDNDGCgxN5Z"

func runExecutor(ctx context.Context, db *store.DB, stopAt <-chan uint64, batchSize uint64) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	// Parse genesis.
	config := genesis.GetConfig(avaconstants.MainnetID)
	var cChainGenesis corethcore.Genesis
	if err := json.Unmarshal([]byte(config.CChainGenesis), &cChainGenesis); err != nil {
		return fmt.Errorf("parse C-Chain genesis config: %w", err)
	}
	if err := cparams.SetEthUpgrades(cChainGenesis.Config); err != nil {
		return fmt.Errorf("set eth upgrades: %w", err)
	}
	chainCfg := cChainGenesis.Config

	// Set up statetrie-backed state database.
	stateTrieDB := statetrie.NewDatabase(db)

	// Load genesis into flat MDBX tables (idempotent).
	if err := loadGenesisFlat(db, &cChainGenesis); err != nil {
		return fmt.Errorf("load genesis: %w", err)
	}

	genesisRoot := cChainGenesis.ToBlock().Root()
	log.Printf("executor: genesis root=%x", genesisRoot)

	// Set up snow.Context for atomic transactions.
	avaxAssetID, err := ids.FromString(MainnetAVAXAssetID)
	if err != nil {
		return fmt.Errorf("invalid AVAX asset ID: %w", err)
	}
	snowCtx := &snow.Context{AVAXAssetID: avaxAssetID}

	// Resume from last executed block.
	roTx, err := db.BeginRO()
	if err != nil {
		return err
	}
	headBlock, hasHead := store.GetHeadBlock(roTx, db)
	roTx.Abort()

	nextBlock := uint64(1)
	if hasHead {
		nextBlock = headBlock + 1
		log.Printf("executor: resuming from block %d", nextBlock)
	}

	if batchSize == 0 {
		batchSize = 1 // default: verify every block
	}

	var maxBlock uint64

	for {
		if ctx.Err() != nil {
			return nil
		}

		select {
		case mb := <-stopAt:
			maxBlock = mb
		default:
		}
		if maxBlock > 0 && nextBlock > maxBlock {
			log.Printf("executor: finished all blocks up to %d", maxBlock)
			return nil
		}

		// Determine batch range.
		batchEnd := nextBlock + batchSize - 1
		if maxBlock > 0 && batchEnd > maxBlock {
			batchEnd = maxBlock
		}

		// Wait for all blocks in this batch to be available.
		for {
			roTx, err := db.BeginRO()
			if err != nil {
				return err
			}
			_, err = store.GetBlockByNumber(roTx, db, batchEnd)
			roTx.Abort()
			if err == nil {
				break
			}
			time.Sleep(100 * time.Millisecond)
			if ctx.Err() != nil {
				return nil
			}
		}

		// Execute the batch.
		if err := executeBatch(db, stateTrieDB, chainCfg, snowCtx, nextBlock, batchEnd); err != nil {
			return err
		}

		nextBlock = batchEnd + 1
	}
}

// executeBatch processes blocks [from, to] inclusive.
// All blocks execute with flat state writes only (no trie hashing).
// Reads go through overlay→MDBX, writes go to overlay only.
// At the end, the state root is computed once (from overlay+MDBX merged)
// and verified against the last block's header. One MDBX Flush at the end.
func executeBatch(
	db *store.DB,
	stateDB *statetrie.Database,
	chainCfg *params.ChainConfig,
	snowCtx *snow.Context,
	from, to uint64,
) error {
	overlay := statetrie.NewBatchOverlay()
	stateDB.Overlay = overlay
	stateDB.SkipHash = true

	// Open a shared RO transaction for all reads during the batch.
	// The overlay handles in-batch writes; MDBX stays read-only.
	if err := stateDB.BeginBatchRO(); err != nil {
		return fmt.Errorf("begin batch RO: %w", err)
	}
	defer stateDB.EndBatchRO()

	for blockNum := from; blockNum <= to; blockNum++ {
		stateDB.CurrentBlock = blockNum
		if err := executeBlock(db, stateDB, chainCfg, snowCtx, blockNum); err != nil {
			stateDB.Overlay = nil
			stateDB.SkipHash = false
			return fmt.Errorf("block %d: %w", blockNum, err)
		}
		if blockNum%100 == 0 || blockNum == to {
			log.Printf("executor: processed block %d", blockNum)
		}
	}

	stateDB.SkipHash = false

	// Verify: compute state root from overlay+MDBX merged state.
	roTx, err := db.BeginRO()
	if err != nil {
		stateDB.Overlay = nil
		return fmt.Errorf("begin RO for verify: %w", err)
	}
	raw, err := store.GetBlockByNumber(roTx, db, to)
	roTx.Abort()
	if err != nil {
		stateDB.Overlay = nil
		return fmt.Errorf("read block %d for verify: %w", to, err)
	}
	ethBlock, err := executorParseEthBlock(raw)
	if err != nil {
		stateDB.Overlay = nil
		return fmt.Errorf("parse block %d for verify: %w", to, err)
	}
	expectedRoot := ethBlock.Header().Root

	computedRoot, err := computeStateRoot(db, overlay)
	if err != nil {
		stateDB.Overlay = nil
		return fmt.Errorf("compute state root at block %d: %w", to, err)
	}

	if computedRoot != expectedRoot {
		stateDB.Overlay = nil
		return fmt.Errorf("state root mismatch at block %d: computed %x, expected %x", to, computedRoot, expectedRoot)
	}

	log.Printf("executor: verified batch %d-%d root=%x", from, to, computedRoot)

	// Flush everything to MDBX in one transaction.
	if err := overlay.Flush(db, to); err != nil {
		stateDB.Overlay = nil
		return fmt.Errorf("flush overlay at block %d: %w", to, err)
	}

	stateDB.Overlay = nil
	return nil
}

// executeBlock processes a single block: EVM execution + flat state writes + changesets.
// No trie hash computation — that's done at batch boundaries.
func executeBlock(
	db *store.DB,
	stateDB *statetrie.Database,
	chainCfg *params.ChainConfig,
	snowCtx *snow.Context,
	blockNum uint64,
) error {
	roTx, err := db.BeginRO()
	if err != nil {
		return err
	}
	raw, err := store.GetBlockByNumber(roTx, db, blockNum)
	if err != nil {
		roTx.Abort()
		return fmt.Errorf("get block: %w", err)
	}
	raw = append([]byte(nil), raw...)
	roTx.Abort()

	ethBlock, err := executorParseEthBlock(raw)
	if err != nil {
		return fmt.Errorf("parse block: %w", err)
	}

	header := ethBlock.Header()

	// Open state from parent — we trust the previous block's header root.
	var parentRoot common.Hash
	if blockNum == 1 {
		parentRoot = common.Hash(common.HexToHash("d65eb1b8604a7aa497d41cd6372663785a5f809a17bd192edb86658ef24e29cc"))
	} else {
		// Read parent block's root.
		proTx, err := db.BeginRO()
		if err != nil {
			return err
		}
		parentRaw, err := store.GetBlockByNumber(proTx, db, blockNum-1)
		proTx.Abort()
		if err != nil {
			return fmt.Errorf("get parent block: %w", err)
		}
		parentBlock, err := executorParseEthBlock(parentRaw)
		if err != nil {
			return fmt.Errorf("parse parent block: %w", err)
		}
		parentRoot = parentBlock.Header().Root
	}

	sdb, err := state.New(parentRoot, stateDB, nil)
	if err != nil {
		return fmt.Errorf("open state at root %x: %w", parentRoot, err)
	}

	ccustomtypes.SetHeaderExtra(header, &ccustomtypes.HeaderExtra{})
	blockCtx := executorBuildBlockContext(header, chainCfg, func(n uint64) common.Hash {
		return common.Hash{}
	})

	gp := new(corethcore.GasPool).AddGas(header.GasLimit)
	signer := ethtypes.MakeSigner(chainCfg, header.Number, header.Time)
	baseFee := header.BaseFee
	if baseFee == nil {
		baseFee = new(big.Int)
	}

	for txIndex, tx := range ethBlock.Transactions() {
		msg, err := corethcore.TransactionToMessage(tx, signer, baseFee)
		if err != nil {
			return fmt.Errorf("tx %d message: %w", txIndex, err)
		}

		sdb.SetTxContext(tx.Hash(), txIndex)

		rules := chainCfg.Rules(header.Number, cparams.IsMergeTODO, header.Time)
		sdb.Prepare(rules, msg.From, header.Coinbase, msg.To,
			vm.ActivePrecompiles(rules), tx.AccessList())

		evm := vm.NewEVM(blockCtx, corethcore.NewEVMTxContext(msg), sdb, chainCfg, vm.Config{})
		result, err := corethcore.ApplyMessage(evm, msg, gp)
		if err != nil {
			return fmt.Errorf("tx %d apply: %w", txIndex, err)
		}
		sdb.Finalise(true)
		if result.Failed() {
			log.Printf("  block %d tx %d reverted: %v", blockNum, txIndex, result.Err)
		}
	}

	// Atomic transactions.
	extData := ccustomtypes.BlockExtData(ethBlock)
	if len(extData) > 0 {
		rules := chainCfg.Rules(header.Number, cparams.IsMergeTODO, header.Time)
		isAP5 := false
		if rulesExtra := cparams.GetRulesExtra(rules); rulesExtra != nil {
			isAP5 = rulesExtra.AvalancheRules.IsApricotPhase5
		}
		atomicTxs, err := atomic.ExtractAtomicTxs(extData, isAP5, atomic.Codec)
		if err != nil {
			return fmt.Errorf("extract atomic txs: %w", err)
		}
		wrappedStateDB := extstate.New(sdb)
		for i, tx := range atomicTxs {
			if err := tx.UnsignedAtomicTx.EVMStateTransfer(snowCtx, wrappedStateDB); err != nil {
				return fmt.Errorf("atomic tx %d state transfer: %w", i, err)
			}
		}
	}

	// Finalise and commit — writes flat state only (SkipHash=true).
	sdb.Finalise(true)
	if _, err := sdb.Commit(blockNum, true); err != nil {
		return fmt.Errorf("commit state: %w", err)
	}

	// Flush changeset.
	if err := stateDB.FlushChangeset(blockNum); err != nil {
		return fmt.Errorf("flush changeset: %w", err)
	}

	return nil
}

// computeStateRoot computes the state root from hashed state tables merged with
// the overlay (if non-nil) in one shot.
// First computes all storage roots, then the account root.
func computeStateRoot(db *store.DB, overlay *statetrie.BatchOverlay) (common.Hash, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	tx, err := db.BeginRO()
	if err != nil {
		return common.Hash{}, err
	}
	defer tx.Abort()

	// Collect merged hashed storage entries from MDBX + overlay.
	type storageKV struct {
		key [64]byte // addrHash(32) + slotHash(32)
		val []byte   // trimmed value
	}
	var allStorage []storageKV

	// First, scan MDBX.
	storageCursor, err := tx.OpenCursor(db.HashedStorageState)
	if err != nil {
		return common.Hash{}, err
	}
	defer storageCursor.Close()

	mdbxStorageKeys := make(map[[64]byte]bool) // track what MDBX has
	k, v, e := storageCursor.Get(nil, nil, mdbx.First)
	for e == nil {
		if len(k) >= 64 {
			var hk [64]byte
			copy(hk[:], k[:64])
			mdbxStorageKeys[hk] = true

			deleted := false
			var val []byte
			if overlay != nil {
				if d, v, ok := overlay.GetHashedStorage(hk); ok {
					if d {
						deleted = true
					} else {
						val = v
					}
				}
			}
			if !deleted {
				if val == nil {
					// Not in overlay, use MDBX value.
					vCopy := make([]byte, len(v))
					copy(vCopy, v)
					val = vCopy
				}
				if len(val) > 0 {
					allStorage = append(allStorage, storageKV{key: hk, val: val})
				}
			}
		}
		k, v, e = storageCursor.Get(nil, nil, mdbx.Next)
	}

	// Add overlay entries not in MDBX.
	if overlay != nil {
		for hk, val := range overlay.HashedStorageEntries() {
			if mdbxStorageKeys[hk] {
				continue // already handled
			}
			if len(val) > 0 {
				allStorage = append(allStorage, storageKV{key: hk, val: val})
			}
		}
	}

	// Sort by key.
	sort.Slice(allStorage, func(i, j int) bool {
		return compareBytes64(allStorage[i].key, allStorage[j].key) < 0
	})

	// Phase 1: compute storage roots.
	storageRoots := make(map[[32]byte][32]byte)
	var currentAddr [32]byte
	var hb *intTrie.HashBuilder
	for _, sv := range allStorage {
		var addrHash [32]byte
		copy(addrHash[:], sv.key[:32])

		if addrHash != currentAddr {
			if hb != nil {
				storageRoots[currentAddr] = hb.Root()
			}
			currentAddr = addrHash
			hb = intTrie.NewHashBuilder()
		}

		slotHash := make([]byte, 32)
		copy(slotHash, sv.key[32:64])
		hb.AddLeaf(intTrie.FromHex(slotHash), rlpEncodeBytesLocal(sv.val))
	}
	if hb != nil {
		storageRoots[currentAddr] = hb.Root()
	}

	// Phase 2: collect merged hashed account entries from MDBX + overlay.
	type accountKV struct {
		key [32]byte
		val []byte // 104-byte encoded account
	}
	var allAccounts []accountKV

	acctCursor, err := tx.OpenCursor(db.HashedAccountState)
	if err != nil {
		return common.Hash{}, err
	}
	defer acctCursor.Close()

	mdbxAcctKeys := make(map[[32]byte]bool)
	k, v, e = acctCursor.Get(nil, nil, mdbx.First)
	for e == nil {
		if len(k) >= 32 {
			var ha [32]byte
			copy(ha[:], k[:32])
			mdbxAcctKeys[ha] = true

			deleted := false
			var val []byte
			if overlay != nil {
				if d, ov, ok := overlay.GetHashedAccount(ha); ok {
					if d {
						deleted = true
					} else {
						val = ov
					}
				}
			}
			if !deleted {
				if val == nil {
					vCopy := make([]byte, len(v))
					copy(vCopy, v)
					val = vCopy
				}
				allAccounts = append(allAccounts, accountKV{key: ha, val: val})
			}
		}
		k, v, e = acctCursor.Get(nil, nil, mdbx.Next)
	}

	// Add overlay entries not in MDBX.
	if overlay != nil {
		for ha, val := range overlay.HashedAccountEntries() {
			if mdbxAcctKeys[ha] {
				continue
			}
			if len(val) > 0 {
				allAccounts = append(allAccounts, accountKV{key: ha, val: val})
			}
		}
	}

	// Sort by key.
	sort.Slice(allAccounts, func(i, j int) bool {
		return compareBytes32Main(allAccounts[i].key, allAccounts[j].key) < 0
	})

	// Phase 2 continued: compute account root.
	acctHB := intTrie.NewHashBuilder()
	for _, av := range allAccounts {
		val := av.val
		// Override StorageRoot with computed one.
		if len(val) >= 104 {
			if sr, ok := storageRoots[av.key]; ok {
				val = make([]byte, len(av.val))
				copy(val, av.val)
				copy(val[72:104], sr[:])
			}
		}
		encoded := manualEncodeAccountRLP(val)
		kCopy := make([]byte, 32)
		copy(kCopy, av.key[:])
		acctHB.AddLeaf(intTrie.FromHex(kCopy), encoded)
	}

	root := acctHB.Root()
	return common.Hash(root), nil
}

func compareBytes64(a, b [64]byte) int {
	for i := 0; i < 64; i++ {
		if a[i] < b[i] {
			return -1
		}
		if a[i] > b[i] {
			return 1
		}
	}
	return 0
}

func compareBytes32Main(a, b [32]byte) int {
	for i := 0; i < 32; i++ {
		if a[i] < b[i] {
			return -1
		}
		if a[i] > b[i] {
			return 1
		}
	}
	return 0
}

// rlpEncodeBytesLocal is a local copy of RLP byte string encoding.
func rlpEncodeBytesLocal(val []byte) []byte {
	if len(val) == 1 && val[0] <= 0x7f {
		return []byte{val[0]}
	}
	out := make([]byte, 1+len(val))
	out[0] = 0x80 + byte(len(val))
	copy(out[1:], val)
	return out
}

// manualEncodeAccountRLP encodes a 104-byte account as StateAccount RLP.
func manualEncodeAccountRLP(val []byte) []byte {
	if len(val) < 104 {
		return nil
	}
	nonce := binary.BigEndian.Uint64(val[0:8])
	balance := val[8:40]
	codeHash := val[40:72]
	storageRoot := val[72:104]

	var buf [160]byte
	off := 3
	off += rlpPutUint64Local(buf[off:], nonce)
	trimBal := balance
	for len(trimBal) > 0 && trimBal[0] == 0 {
		trimBal = trimBal[1:]
	}
	off += rlpPutBytesLocal(buf[off:], trimBal)
	buf[off] = 0xa0
	copy(buf[off+1:], storageRoot[:32])
	off += 33
	buf[off] = 0xa0
	copy(buf[off+1:], codeHash[:32])
	off += 33
	buf[off] = 0x80
	off++

	payloadLen := off - 3
	var start int
	if payloadLen <= 55 {
		start = 2
		buf[start] = 0xc0 + byte(payloadLen)
	} else {
		start = 1
		buf[start] = 0xf8
		buf[start+1] = byte(payloadLen)
	}
	out := make([]byte, off-start)
	copy(out, buf[start:off])
	return out
}

func rlpPutUint64Local(dst []byte, v uint64) int {
	if v == 0 {
		dst[0] = 0x80
		return 1
	}
	if v <= 0x7f {
		dst[0] = byte(v)
		return 1
	}
	n := 0
	tmp := v
	for tmp > 0 {
		n++
		tmp >>= 8
	}
	dst[0] = 0x80 + byte(n)
	for i := n; i > 0; i-- {
		dst[i] = byte(v)
		v >>= 8
	}
	return 1 + n
}

func rlpPutBytesLocal(dst []byte, b []byte) int {
	if len(b) == 0 {
		dst[0] = 0x80
		return 1
	}
	if len(b) == 1 && b[0] <= 0x7f {
		dst[0] = b[0]
		return 1
	}
	dst[0] = 0x80 + byte(len(b))
	copy(dst[1:], b)
	return 1 + len(b)
}

// loadGenesisFlat writes genesis alloc to flat MDBX state tables (plain + hashed).
// Idempotent: checks metadata for "genesis_loaded" marker.
func loadGenesisFlat(db *store.DB, gen *corethcore.Genesis) error {
	// Check if already loaded.
	tx, err := db.BeginRO()
	if err != nil {
		return err
	}
	_, loadErr := tx.Get(db.Metadata, []byte("genesis_loaded"))
	tx.Abort()
	if loadErr == nil {
		return nil // already loaded
	}

	// Write genesis alloc to flat state.
	rwTx, err := db.BeginRW()
	if err != nil {
		return err
	}

	for addr, account := range gen.Alloc {
		var addr20 [20]byte
		copy(addr20[:], addr[:])
		hashedAddr := crypto.Keccak256(addr[:])
		var ha [32]byte
		copy(ha[:], hashedAddr)

		codeHash := store.EmptyCodeHash
		if len(account.Code) > 0 {
			codeHash = [32]byte(crypto.Keccak256Hash(account.Code))
			if err := store.PutCode(rwTx, db, codeHash, account.Code); err != nil {
				rwTx.Abort()
				return err
			}
		}

		var balance [32]byte
		if account.Balance != nil {
			bal, _ := uint256.FromBig(account.Balance)
			bal.WriteToArray32(&balance)
		}

		acct := &store.Account{
			Nonce:       account.Nonce,
			Balance:     balance,
			CodeHash:    codeHash,
			StorageRoot: store.EmptyRootHash,
		}
		if err := store.PutAccount(rwTx, db, addr20, acct); err != nil {
			rwTx.Abort()
			return err
		}

		// Also write to hashed account state.
		if err := store.PutHashedAccount(rwTx, db, ha, store.EncodeAccountBytes(acct)); err != nil {
			rwTx.Abort()
			return err
		}

		for slot, value := range account.Storage {
			if err := store.PutStorage(rwTx, db, addr20, [32]byte(slot), [32]byte(value)); err != nil {
				rwTx.Abort()
				return err
			}

			// Hashed storage.
			hashedSlot := crypto.Keccak256(slot[:])
			var hs [32]byte
			copy(hs[:], hashedSlot)
			// Trim leading zeros for hashed storage value.
			val32 := [32]byte(value)
			trimmed := val32[:]
			for len(trimmed) > 0 && trimmed[0] == 0 {
				trimmed = trimmed[1:]
			}
			if len(trimmed) > 0 {
				if err := store.PutHashedStorage(rwTx, db, ha, hs, trimmed); err != nil {
					rwTx.Abort()
					return err
				}
			}
		}
	}

	if err := rwTx.Put(db.Metadata, []byte("genesis_loaded"), []byte{1}, 0); err != nil {
		rwTx.Abort()
		return err
	}

	_, err = rwTx.Commit()
	return err
}

// executorParseEthBlock decodes a raw block from MDBX. It first tries to unwrap a
// ProposerVM envelope; if that fails it falls back to a pre-fork RLP decode.
func executorParseEthBlock(raw []byte) (*ethtypes.Block, error) {
	if blk, err := proposerblock.ParseWithoutVerification(raw); err == nil {
		ethBlock := new(ethtypes.Block)
		if err := rlp.DecodeBytes(blk.Block(), ethBlock); err != nil {
			return nil, fmt.Errorf("decode inner eth block: %w", err)
		}
		return ethBlock, nil
	}

	_, _, rest, err := rlp.Split(raw)
	if err != nil {
		return nil, fmt.Errorf("rlp split: %w", err)
	}
	rawBlock := raw[:len(raw)-len(rest)]

	ethBlock := new(ethtypes.Block)
	if err := rlp.DecodeBytes(rawBlock, ethBlock); err != nil {
		return nil, fmt.Errorf("decode pre-fork eth block: %w", err)
	}
	return ethBlock, nil
}

// executorBuildBlockContext constructs the vm.BlockContext needed for EVM execution.
func executorBuildBlockContext(header *ethtypes.Header, chainCfg *params.ChainConfig, getHash func(uint64) common.Hash) vm.BlockContext {
	rules := chainCfg.Rules(header.Number, cparams.IsMergeTODO, header.Time)

	blockDifficulty := new(big.Int)
	if header.Difficulty != nil {
		blockDifficulty.Set(header.Difficulty)
	}
	blockRandom := header.MixDigest
	if rules.IsShanghai {
		blockRandom.SetBytes(blockDifficulty.Bytes())
		blockDifficulty = new(big.Int)
	}

	return vm.BlockContext{
		CanTransfer: func(db vm.StateDB, addr common.Address, amount *uint256.Int) bool {
			return db.GetBalance(addr).Cmp(amount) >= 0
		},
		Transfer: func(db vm.StateDB, sender, recipient common.Address, amount *uint256.Int) {
			db.SubBalance(sender, amount)
			db.AddBalance(recipient, amount)
		},
		GetHash:     getHash,
		Coinbase:    header.Coinbase,
		BlockNumber: new(big.Int).Set(header.Number),
		Time:        header.Time,
		Difficulty:  blockDifficulty,
		Random:      &blockRandom,
		GasLimit:    header.GasLimit,
		BaseFee:     executorBaseFeeOrZero(header.BaseFee),
		Header:      header,
	}
}

func executorBaseFeeOrZero(b *big.Int) *big.Int {
	if b != nil {
		return new(big.Int).Set(b)
	}
	return new(big.Int)
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
