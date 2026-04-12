package main

import (
	"context"
	_ "embed"
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
	"sync"
	syncatomic "sync/atomic"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/ava-labs/avalanchego/api/info"
	"github.com/ava-labs/avalanchego/genesis"
	"github.com/ava-labs/avalanchego/upgrade"
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

	rpcpkg "block_fetcher/rpc"
	"block_fetcher/statetrie"
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

	// Response routing for parallel fetcher: requestID -> dedicated channel.
	// When a worker registers a channel, the AncestorsOp handler routes
	// the response to that channel instead of the shared ancestorsCh.
	routeMu  sync.Mutex
	routeMap map[uint32]chan ancestorsResponse
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
		resp := ancestorsResponse{
			nodeID:    msg.NodeID,
			requestID: payload.RequestId,
			blocks:    payload.Containers,
		}
		// Try to route to a registered worker channel first.
		h.routeMu.Lock()
		ch, routed := h.routeMap[payload.RequestId]
		if routed {
			delete(h.routeMap, payload.RequestId)
		}
		h.routeMu.Unlock()
		if routed {
			select {
			case ch <- resp:
			default:
			}
		} else {
			select {
			case h.ancestorsCh <- resp:
			default:
			}
		}
	}
}

// registerRoute registers a one-shot response channel for a specific requestID.
func (h *inboundHandler) registerRoute(requestID uint32, ch chan ancestorsResponse) {
	h.routeMu.Lock()
	h.routeMap[requestID] = ch
	h.routeMu.Unlock()
}

// unregisterRoute removes a route (e.g. on timeout).
func (h *inboundHandler) unregisterRoute(requestID uint32) {
	h.routeMu.Lock()
	delete(h.routeMap, requestID)
	h.routeMu.Unlock()
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
		execBatchSize  = flag.Uint64("exec-batch-size", 50000, "number of blocks per executor batch (verified every batch)")
		fetchWorkers   = flag.Int("fetch-workers", 32, "number of parallel fetch workers")
		execOnly       = flag.Bool("exec-only", false, "run executor only, no fetcher/writer/network")
		rpcAddr        = flag.String("rpc-addr", ":9670", "JSON-RPC server listen address")
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

	// Start JSON-RPC server.
	rpcBackend := rpcpkg.NewBackend(db)
	rpcServer := rpcpkg.NewServer(rpcBackend)
	go func() {
		if err := rpcServer.ListenAndServe(*rpcAddr); err != nil {
			log.Printf("RPC server error: %v", err)
		}
	}()

	executorStopAt := make(chan uint64, 1)
	executorErrCh := make(chan error, 1)
	go func() {
		executorErrCh <- runExecutor(ctx, db, executorStopAt, *execBatchSize)
	}()

	if *execOnly {
		log.Printf("exec-only mode: no fetcher/writer")
		if err := <-executorErrCh; err != nil {
			log.Fatalf("executor: %v", err)
		}
		return
	}

	writerCh := make(chan []byte, *writerBuffer)
	writerErrCh := make(chan error, 1)
	go func() {
		writerErrCh <- runWriter(ctx, db, writerCh, *batchSize)
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
		routeMap:    make(map[uint32]chan ancestorsResponse),
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

	// Build fetch jobs from embedded checkpoints and run the parallel fetcher.
	maxBlock, fetchErr := runParallelFetcher(
		ctx,
		db,
		net,
		msgCreator,
		chainID,
		peerTracker,
		handler,
		writerCh,
		writerErrCh,
		dispatchErrCh,
		*requestWait,
		*fetchWorkers,
	)
	close(writerCh)
	if writerErr := <-writerErrCh; writerErr != nil {
		log.Fatalf("writer failed: %v", writerErr)
	}
	if fetchErr != nil {
		log.Fatalf("parallel fetcher: %v", fetchErr)
	}

	// Tell executor the max block number and wait.
	if maxBlock > 0 {
		executorStopAt <- maxBlock
		log.Printf("waiting for executor to finish processing up to block %d...", maxBlock)
		if err := <-executorErrCh; err != nil {
			log.Fatalf("executor failed: %v", err)
		}
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
	// Set Avalanche network upgrade timestamps on the chain config.
	// The genesis JSON only has standard Ethereum forks — Avalanche-specific
	// upgrades (ApricotPhase1-5, Banff, Cortina, etc.) must be set from the
	// known mainnet upgrade schedule.
	mainnetUpgrades := upgrade.GetConfig(avaconstants.MainnetID)
	setAvalancheUpgrades(cChainGenesis.Config, mainnetUpgrades)
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

	// One-time migration: wipe StorageTrie + AccountTrie branch nodes built by
	// old code with degraded TreeMask values. Gated by metadata flag so it runs
	// once. After this, the incremental hasher rebuilds correct branch nodes.
	{
		rtx, _ := db.BeginRO()
		_, migErr := rtx.Get(db.Metadata, []byte("trie_v2"))
		rtx.Abort()
		if migErr != nil {
			log.Printf("executor: one-time trie migration — clearing StorageTrie + AccountTrie")
			runtime.LockOSThread()
			wtx, err := db.BeginRW()
			if err != nil {
				runtime.UnlockOSThread()
				return fmt.Errorf("begin RW for trie migration: %w", err)
			}
			if err := wtx.Drop(db.StorageTrie, false); err != nil {
				wtx.Abort()
				runtime.UnlockOSThread()
				return fmt.Errorf("drop StorageTrie: %w", err)
			}
			if err := wtx.Drop(db.AccountTrie, false); err != nil {
				wtx.Abort()
				runtime.UnlockOSThread()
				return fmt.Errorf("drop AccountTrie: %w", err)
			}
			if err := wtx.Put(db.Metadata, []byte("trie_v2"), []byte("1"), 0); err != nil {
				wtx.Abort()
				runtime.UnlockOSThread()
				return fmt.Errorf("set trie_v2 flag: %w", err)
			}
			if _, err := wtx.Commit(); err != nil {
				runtime.UnlockOSThread()
				return fmt.Errorf("commit trie migration: %w", err)
			}
			runtime.UnlockOSThread()
			log.Printf("executor: trie migration complete")
		}
	}

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

	// Open a shared RO transaction for all reads during the batch.
	// The overlay handles in-batch writes; MDBX stays read-only.
	if err := stateDB.BeginBatchRO(); err != nil {
		return fmt.Errorf("begin batch RO: %w", err)
	}
	// EndBatchRO is called explicitly before the RW transaction below.
	// Defer as safety net in case of early return.
	batchROClosed := false
	defer func() {
		if !batchROClosed {
			stateDB.EndBatchRO()
		}
	}()

	// Hard timeout: scale with batch size (roughly 1s per 500 blocks, minimum 60s).
	batchTimeout := time.Duration(to-from+1) * 5 * time.Millisecond
	if batchTimeout < 120*time.Second {
		batchTimeout = 120 * time.Second
	}
	batchTimer := time.AfterFunc(batchTimeout, func() {
		log.Fatalf("executor: FATAL batch %d-%d exceeded %v timeout — killing process", from, to, batchTimeout)
	})
	defer batchTimer.Stop()

	execStart := time.Now()
	for blockNum := from; blockNum <= to; blockNum++ {
		stateDB.CurrentBlock = blockNum
		if err := executeBlock(db, stateDB, chainCfg, snowCtx, blockNum); err != nil {
			stateDB.Overlay = nil
			return fmt.Errorf("block %d: %w", blockNum, err)
		}
		if blockNum%1000 == 0 || blockNum == to {
			log.Printf("executor: processed block %d", blockNum)
		}
	}
	execElapsed := time.Since(execStart)

	stateDB.EndBatchRO() // close RO before opening RW
	batchROClosed = true

	// Read expected root from block header.
	roTx, err := db.BeginRO()
	if err != nil {
		stateDB.Overlay = nil
		return fmt.Errorf("begin RO for verify: %w", err)
	}
	raw, err := store.GetBlockByNumber(roTx, db, to)
	if err != nil {
		roTx.Abort()
		stateDB.Overlay = nil
		return fmt.Errorf("read block %d for verify: %w", to, err)
	}
	raw = append([]byte(nil), raw...) // copy before abort
	ethBlock, err := executorParseEthBlock(raw)
	if err != nil {
		roTx.Abort()
		stateDB.Overlay = nil
		return fmt.Errorf("parse block %d for verify: %w", to, err)
	}
	expectedRoot := ethBlock.Header().Root

	// Capture old storage roots before flushing (overlay has dummy zeros for storage roots).
	changedAccounts := overlay.ChangedAccountHashes()
	oldStorageRoots := statetrie.ReadOldStorageRoots(roTx, db, changedAccounts)
	roTx.Abort()

	// Flush + incremental hash + verify in one RW transaction.
	hashStart := time.Now()
	runtime.LockOSThread()
	rwTx, err := db.BeginRW()
	if err != nil {
		runtime.UnlockOSThread()
		stateDB.Overlay = nil
		return fmt.Errorf("begin RW for flush+hash: %w", err)
	}

	if err := overlay.FlushStateToTx(rwTx, db); err != nil {
		rwTx.Abort()
		runtime.UnlockOSThread()
		stateDB.Overlay = nil
		return fmt.Errorf("flush state at block %d: %w", to, err)
	}

	computedRoot, err := statetrie.ComputeIncrementalStateRoot(rwTx, db, overlay, oldStorageRoots)
	if err != nil {
		rwTx.Abort()
		runtime.UnlockOSThread()
		stateDB.Overlay = nil
		return fmt.Errorf("incremental state root at block %d: %w", to, err)
	}
	hashElapsed := time.Since(hashStart)

	if common.Hash(computedRoot) != expectedRoot {
		// Incremental hash failed — fall back to full root.
		fullRoot, fullErr := statetrie.ComputeFullStateRoot(rwTx, db)
		if fullErr != nil || common.Hash(fullRoot) != expectedRoot {
			log.Printf("executor: MISMATCH block %d: incremental=%x full=%x expected=%x fullErr=%v",
				to, computedRoot, fullRoot, expectedRoot, fullErr)
			rwTx.Abort()
			runtime.UnlockOSThread()
			stateDB.Overlay = nil
			return fmt.Errorf("state root mismatch at block %d", to)
		}
		statetrie.CompareLeafEncoding(rwTx, db, overlay)
		log.Printf("executor: incremental wrong at block %d, used full root (incremental=%x)",
			to, computedRoot[:8])
		computedRoot = fullRoot
	}

	if err := store.SetHeadBlock(rwTx, db, to); err != nil {
		rwTx.Abort()
		runtime.UnlockOSThread()
		stateDB.Overlay = nil
		return fmt.Errorf("set head block %d: %w", to, err)
	}

	commitStart := time.Now()
	if _, err := rwTx.Commit(); err != nil {
		runtime.UnlockOSThread()
		stateDB.Overlay = nil
		return fmt.Errorf("commit at block %d: %w", to, err)
	}
	commitElapsed := time.Since(commitStart)
	runtime.UnlockOSThread()

	log.Printf("executor: verified batch %d-%d root=%x (exec=%s hash=%s commit=%s)", from, to, common.Hash(computedRoot), execElapsed.Truncate(time.Millisecond), hashElapsed.Truncate(time.Millisecond), commitElapsed.Truncate(time.Millisecond))

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
		roTx2, err := db.BeginRO()
		if err != nil {
			return common.Hash{}
		}
		defer roTx2.Abort()
		raw, err := store.GetBlockByNumber(roTx2, db, n)
		if err != nil {
			return common.Hash{}
		}
		blk, err := executorParseEthBlock(raw)
		if err != nil {
			return common.Hash{}
		}
		return blk.Hash()
	})

	gp := new(corethcore.GasPool).AddGas(header.GasLimit)
	signer := ethtypes.MakeSigner(chainCfg, header.Number, header.Time)
	baseFee := header.BaseFee
	if baseFee == nil {
		baseFee = new(big.Int)
	}

	var blockReceipts []store.TxReceipt
	cumulativeGas := uint64(0)

	for txIndex, tx := range ethBlock.Transactions() {
		msg, err := corethcore.TransactionToMessage(tx, signer, baseFee)
		if err != nil {
			return fmt.Errorf("tx %d message: %w", txIndex, err)
		}

		sdb.SetTxContext(tx.Hash(), txIndex)

		rules := chainCfg.Rules(header.Number, cparams.IsMergeTODO, header.Time)
		sdb.Prepare(rules, msg.From, header.Coinbase, msg.To,
			vm.ActivePrecompiles(rules), tx.AccessList())

		// DEBUG: log coinbase balance before/after for the failing block
		if blockNum == 3308764 {
			coinbase := header.Coinbase
			log.Printf("  DEBUG block %d tx %d: coinbase %x balance_before=%s baseFee=%v gasPrice=%v",
				blockNum, txIndex, coinbase[:4], sdb.GetBalance(coinbase), header.BaseFee, msg.GasPrice)
		}

		evm := vm.NewEVM(blockCtx, corethcore.NewEVMTxContext(msg), sdb, chainCfg, vm.Config{})
		result, err := corethcore.ApplyMessage(evm, msg, gp)
		if err != nil {
			return fmt.Errorf("tx %d apply: %w", txIndex, err)
		}
		sdb.Finalise(true)

		if blockNum == 3308764 {
			coinbase := header.Coinbase
			log.Printf("  DEBUG block %d tx %d: coinbase balance_after=%s gasUsed=%d",
				blockNum, txIndex, sdb.GetBalance(coinbase), result.UsedGas)
		}
		if result.Failed() {
			log.Printf("  block %d tx %d reverted: %v", blockNum, txIndex, result.Err)
		}

		// Build receipt from execution result.
		cumulativeGas += result.UsedGas
		receipt := store.TxReceipt{
			TxHash:        [32]byte(tx.Hash()),
			CumulativeGas: cumulativeGas,
			GasUsed:       result.UsedGas,
			TxType:        tx.Type(),
		}
		if result.Failed() {
			receipt.Status = 0
		} else {
			receipt.Status = 1
		}

		// Contract creation address.
		if tx.To() == nil && !result.Failed() {
			contractAddr := crypto.CreateAddress(msg.From, tx.Nonce())
			receipt.ContractAddress = [20]byte(contractAddr)
		}

		// Capture logs.
		txLogs := sdb.GetLogs(tx.Hash(), blockNum, common.Hash{})
		for _, l := range txLogs {
			entry := store.LogEntry{
				Address: [20]byte(l.Address),
				Data:    l.Data,
			}
			for _, t := range l.Topics {
				entry.Topics = append(entry.Topics, [32]byte(t))
			}
			receipt.Logs = append(receipt.Logs, entry)
		}

		blockReceipts = append(blockReceipts, receipt)

		// Record tx hash → (blockNum, txIndex).
		if stateDB != nil && stateDB.Overlay != nil {
			stateDB.Overlay.AddTxHash([32]byte(tx.Hash()), blockNum, uint16(txIndex))
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

	// Finalise and commit — writes flat state to overlay.
	sdb.Finalise(true)
	if _, err := sdb.Commit(blockNum, true); err != nil {
		return fmt.Errorf("commit state: %w", err)
	}

	// Store receipts and block hash in overlay.
	if stateDB != nil && stateDB.Overlay != nil {
		if len(blockReceipts) > 0 {
			stateDB.Overlay.AddBlockReceipts(blockNum, blockReceipts)
		}
		stateDB.Overlay.AddBlockHash([32]byte(ethBlock.Hash()), blockNum)
	}

	// Flush changeset.
	if err := stateDB.FlushChangeset(blockNum); err != nil {
		return fmt.Errorf("flush changeset: %w", err)
	}

	return nil
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

// setAvalancheUpgrades sets the Avalanche network upgrade timestamps on the
// chain config extras. The genesis JSON only has standard Ethereum forks;
// Avalanche-specific upgrades must be set from the known upgrade schedule.
func setAvalancheUpgrades(c *params.ChainConfig, cfg upgrade.Config) {
	extra := cparams.GetExtra(c)
	ts := func(t time.Time) *uint64 { v := uint64(t.Unix()); return &v }
	extra.NetworkUpgrades.ApricotPhase1BlockTimestamp = ts(cfg.ApricotPhase1Time)
	extra.NetworkUpgrades.ApricotPhase2BlockTimestamp = ts(cfg.ApricotPhase2Time)
	extra.NetworkUpgrades.ApricotPhase3BlockTimestamp = ts(cfg.ApricotPhase3Time)
	extra.NetworkUpgrades.ApricotPhase4BlockTimestamp = ts(cfg.ApricotPhase4Time)
	extra.NetworkUpgrades.ApricotPhase5BlockTimestamp = ts(cfg.ApricotPhase5Time)
	extra.NetworkUpgrades.ApricotPhasePre6BlockTimestamp = ts(cfg.ApricotPhasePre6Time)
	extra.NetworkUpgrades.ApricotPhase6BlockTimestamp = ts(cfg.ApricotPhase6Time)
	extra.NetworkUpgrades.ApricotPhasePost6BlockTimestamp = ts(cfg.ApricotPhasePost6Time)
	extra.NetworkUpgrades.BanffBlockTimestamp = ts(cfg.BanffTime)
	extra.NetworkUpgrades.CortinaBlockTimestamp = ts(cfg.CortinaTime)
	extra.NetworkUpgrades.DurangoBlockTimestamp = ts(cfg.DurangoTime)
	extra.NetworkUpgrades.EtnaTimestamp = ts(cfg.EtnaTime)
	cparams.WithExtra(c, extra)
	log.Printf("executor: Avalanche upgrades set (AP1=%d AP2=%d AP3=%d AP5=%d Banff=%d Cortina=%d Durango=%d Etna=%d)",
		cfg.ApricotPhase1Time.Unix(), cfg.ApricotPhase2Time.Unix(), cfg.ApricotPhase3Time.Unix(),
		cfg.ApricotPhase5Time.Unix(), cfg.BanffTime.Unix(), cfg.CortinaTime.Unix(),
		cfg.DurangoTime.Unix(), cfg.EtnaTime.Unix())
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

// --- Parallel Fetcher ---

// fetchJob represents a range of blocks to fetch walking backwards from tipID.
// The worker walks from fromBlock down to toBlock (inclusive).
type fetchJob struct {
	fromBlock uint64 // higher block number (start here, walk backwards)
	toBlock   uint64 // lower block number (stop when reached)
	tipID     ids.ID // known container ID at fromBlock
}

// checkpoint is a parsed entry from container_ids.json.
type checkpoint struct {
	blockNum    uint64
	containerID ids.ID
}

// parseCheckpoints parses the embedded container_ids.json into a sorted list of checkpoints.
func parseCheckpoints() ([]checkpoint, error) {
	var raw map[string]string
	if err := json.Unmarshal(embeddedContainerIDs, &raw); err != nil {
		return nil, fmt.Errorf("decode embedded container ids: %w", err)
	}

	cps := make([]checkpoint, 0, len(raw))
	for blockStr, idStr := range raw {
		num, err := strconv.ParseUint(blockStr, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("parse block number %q: %w", blockStr, err)
		}
		cid, err := ids.FromString(idStr)
		if err != nil {
			return nil, fmt.Errorf("parse container ID for block %s: %w", blockStr, err)
		}
		cps = append(cps, checkpoint{blockNum: num, containerID: cid})
	}

	// Sort ascending by block number.
	sort.Slice(cps, func(i, j int) bool {
		return cps[i].blockNum < cps[j].blockNum
	})
	return cps, nil
}

// buildFetchJobs creates fetch jobs from checkpoints. Each job covers the range
// (checkpoint[i-1].blockNum, checkpoint[i].blockNum] walking backwards from
// checkpoint[i]. Jobs are sorted by toBlock ascending so lowest ranges are fetched first.
func buildFetchJobs(checkpoints []checkpoint) []fetchJob {
	jobs := make([]fetchJob, 0, len(checkpoints))

	for i, cp := range checkpoints {
		var toBlock uint64
		if i == 0 {
			// First checkpoint: walk from this checkpoint down to block 1 (genesis is block 0).
			toBlock = 1
		} else {
			// Walk from this checkpoint down to just after the previous checkpoint.
			toBlock = checkpoints[i-1].blockNum + 1
		}
		jobs = append(jobs, fetchJob{
			fromBlock: cp.blockNum,
			toBlock:   toBlock,
			tipID:     cp.containerID,
		})
	}

	// Sort by toBlock ascending so lowest ranges are prioritized.
	sort.Slice(jobs, func(i, j int) bool {
		return jobs[i].toBlock < jobs[j].toBlock
	})
	return jobs
}

// runParallelFetcher manages concurrent fetch workers pulling blocks from peers.
// Returns the highest block number across all jobs when complete.
func runParallelFetcher(
	ctx context.Context,
	db *store.DB,
	net network.Network,
	msgCreator message.Creator,
	chainID ids.ID,
	peerTracker *avap2p.PeerTracker,
	handler *inboundHandler,
	writerCh chan<- []byte,
	writerErrCh <-chan error,
	dispatchErrCh <-chan error,
	requestTimeout time.Duration,
	numWorkers int,
) (uint64, error) {
	checkpoints, err := parseCheckpoints()
	if err != nil {
		return 0, fmt.Errorf("parse checkpoints: %w", err)
	}
	if len(checkpoints) == 0 {
		return 0, fmt.Errorf("no checkpoints found")
	}

	allJobs := buildFetchJobs(checkpoints)
	log.Printf("parallel fetcher: %d jobs from %d checkpoints, %d workers",
		len(allJobs), len(checkpoints), numWorkers)

	// Filter out jobs that are already fully fetched.
	// Check every block in the range via cursor scan — not just endpoints.
	var pendingJobs []fetchJob
	roTx, err := db.BeginRO()
	if err != nil {
		return 0, err
	}
	for _, job := range allJobs {
		expected := job.fromBlock - job.toBlock + 1
		count, err := store.CountContainersInRange(roTx, db, job.toBlock, job.fromBlock)
		if err != nil {
			roTx.Abort()
			return 0, err
		}
		if count == expected {
			log.Printf("parallel fetcher: skipping completed job [%d, %d]", job.toBlock, job.fromBlock)
			continue
		}
		log.Printf("parallel fetcher: job [%d, %d] has %d/%d blocks, needs fetch", job.toBlock, job.fromBlock, count, expected)
		pendingJobs = append(pendingJobs, job)
	}
	roTx.Abort()

	if len(pendingJobs) == 0 {
		log.Printf("parallel fetcher: all jobs already complete")
		return checkpoints[len(checkpoints)-1].blockNum, nil
	}

	log.Printf("parallel fetcher: %d pending jobs (of %d total)", len(pendingJobs), len(allJobs))

	// Job queue protected by mutex. Workers pull from the front (lowest range first).
	var jobMu sync.Mutex
	jobIdx := 0

	// Global atomic request ID counter — each worker gets unique IDs.
	var globalRequestID syncatomic.Uint32
	globalRequestID.Store(1)

	// Track total blocks fetched across all workers.
	var totalFetched syncatomic.Int64

	// Per-peer in-flight request limiter.
	// Avalanchego default is 1024 concurrent msgs/peer; cap at 4 to spread load.
	const maxInflightPerPeer = 4
	var peerInflightMu sync.Mutex
	peerInflight := make(map[ids.NodeID]int)

	started := time.Now()

	// Progress reporter.
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				fetched := totalFetched.Load()
				elapsed := time.Since(started).Seconds()
				if elapsed > 0 {
					log.Printf("parallel fetcher: total_fetched=%d elapsed=%.1fs blocks_per_sec=%.0f",
						fetched, elapsed, float64(fetched)/elapsed)
				}
			}
		}
	}()

	// Worker function.
	workerFn := func(workerID int) error {
		// Each worker has its own response channel.
		respCh := make(chan ancestorsResponse, 1)

		for {
			if ctx.Err() != nil {
				return nil
			}

			// Grab the next job.
			jobMu.Lock()
			if jobIdx >= len(pendingJobs) {
				jobMu.Unlock()
				return nil // no more jobs
			}
			job := pendingJobs[jobIdx]
			jobIdx++
			jobMu.Unlock()

			log.Printf("worker %d: starting job [%d -> %d] tipID=%s",
				workerID, job.fromBlock, job.toBlock, job.tipID)

			jobStart := time.Now()
			jobBlocks := 0
			nextID := job.tipID

			for nextID != ids.Empty {
				if ctx.Err() != nil {
					return nil
				}

				// Check for writer/dispatch errors.
				select {
				case err := <-writerErrCh:
					if err != nil {
						return fmt.Errorf("writer failed: %w", err)
					}
					return fmt.Errorf("writer stopped unexpectedly")
				case err := <-dispatchErrCh:
					if err != nil {
						return fmt.Errorf("network stopped: %w", err)
					}
					return fmt.Errorf("network stopped unexpectedly")
				default:
				}

				reqID := globalRequestID.Add(1) - 1

				// Pick a peer that isn't at the in-flight limit.
				var peerID ids.NodeID
				peerFound := false
				for attempts := 0; attempts < 64; attempts++ {
					candidate, ok := peerTracker.SelectPeer()
					if !ok {
						break
					}
					peerInflightMu.Lock()
					if peerInflight[candidate] < maxInflightPerPeer {
						peerInflight[candidate]++
						peerInflightMu.Unlock()
						peerID = candidate
						peerFound = true
						break
					}
					peerInflightMu.Unlock()
				}
				if !peerFound {
					time.Sleep(100 * time.Millisecond)
					continue
				}
				peerTracker.RegisterRequest(peerID)

				// Register the response route before sending.
				handler.registerRoute(reqID, respCh)

				outMsg, err := msgCreator.GetAncestors(
					chainID, reqID, requestTimeout, nextID,
					p2p.EngineType_ENGINE_TYPE_CHAIN,
				)
				if err != nil {
					handler.unregisterRoute(reqID)
					return fmt.Errorf("create GetAncestors message: %w", err)
				}

				sendStarted := time.Now()
				net.Send(
					outMsg,
					avacommon.SendConfig{NodeIDs: set.Of(peerID)},
					avaconstants.PrimaryNetworkID,
					subnets.NoOpAllower,
				)

				// Wait for response with timeout.
				timer := time.NewTimer(requestTimeout)
				var resp ancestorsResponse
				gotResp := false
				select {
				case <-ctx.Done():
					timer.Stop()
					handler.unregisterRoute(reqID)
					peerInflightMu.Lock()
					peerInflight[peerID]--
					peerInflightMu.Unlock()
					return nil
				case <-timer.C:
					handler.unregisterRoute(reqID)
					peerTracker.RegisterFailure(peerID)
					peerInflightMu.Lock()
					peerInflight[peerID]--
					peerInflightMu.Unlock()
					log.Printf("worker %d: timeout waiting for ancestors from %s reqID=%d blockID=%s",
						workerID, peerID, reqID, nextID)
					continue
				case resp = <-respCh:
					timer.Stop()
					gotResp = true
				}

				peerInflightMu.Lock()
				peerInflight[peerID]--
				peerInflightMu.Unlock()

				if !gotResp || len(resp.blocks) == 0 {
					peerTracker.RegisterFailure(peerID)
					continue
				}

				// Score the peer based on throughput.
				numBytes := 0
				for _, blk := range resp.blocks {
					numBytes += len(blk)
				}
				elapsed := time.Since(sendStarted).Seconds()
				if elapsed <= 0 {
					elapsed = 1e-9
				}
				peerTracker.RegisterResponse(peerID, float64(numBytes)/elapsed)

				// Process the response: parse and enqueue blocks.
				batchValid := true
				var oldestMeta blockMeta
				for i := 0; i < len(resp.blocks); i++ {
					raw := append([]byte(nil), resp.blocks[i]...)
					if len(raw) == 0 {
						peerTracker.RegisterFailure(peerID)
						batchValid = false
						break
					}
					meta, err := parseBlockMeta(raw)
					if err != nil {
						log.Printf("worker %d: parse block %d/%d failed: %v",
							workerID, i, len(resp.blocks), err)
						peerTracker.RegisterFailure(peerID)
						batchValid = false
						break
					}
					select {
					case writerCh <- raw:
					case <-ctx.Done():
						return nil
					}
					oldestMeta = meta
					jobBlocks++
				}
				if !batchValid {
					continue
				}

				totalFetched.Add(int64(len(resp.blocks)))

				// Check if we've reached or passed the lower bound of our job.
				// The last block in the response is the oldest. We need to check
				// if we've walked past job.toBlock. Parse the oldest block to get its number.
				// We don't have a direct block number from the meta, but we can check
				// if the parentID is the genesis (ids.Empty) or if we should stop.
				// Actually, let's check: if the parent of the oldest block is before our range,
				// we're done. Since we can't directly check the block number from the meta,
				// we rely on the writer storing blocks and the fact that GetAncestors returns
				// blocks in order. We check the DB for the toBlock to see if it's been stored.
				nextID = oldestMeta.parentID

				// Quick check: if parentID is empty, we've reached genesis.
				if nextID == ids.Empty {
					break
				}
			}

			jobElapsed := time.Since(jobStart)
			rate := float64(0)
			if jobElapsed.Seconds() > 0 {
				rate = float64(jobBlocks) / jobElapsed.Seconds()
			}
			log.Printf("worker %d: finished job [%d -> %d] blocks=%d elapsed=%s rate=%.0f/s",
				workerID, job.fromBlock, job.toBlock, jobBlocks,
				jobElapsed.Truncate(time.Millisecond), rate)
		}
		return nil
	}

	// Launch workers.
	if numWorkers > len(pendingJobs) {
		numWorkers = len(pendingJobs)
	}
	var wg sync.WaitGroup
	errCh := make(chan error, numWorkers)
	for i := 0; i < numWorkers; i++ {
		wg.Add(1)
		workerID := i
		go func() {
			defer wg.Done()
			if err := workerFn(workerID); err != nil {
				errCh <- err
			}
		}()
	}

	// Wait for all workers to finish.
	wg.Wait()
	close(errCh)

	// Report any errors.
	for err := range errCh {
		if err != nil {
			return 0, err
		}
	}

	fetched := totalFetched.Load()
	elapsed := time.Since(started)
	log.Printf("parallel fetcher: complete total_fetched=%d elapsed=%s blocks_per_sec=%.0f",
		fetched, elapsed.Truncate(time.Millisecond), float64(fetched)/elapsed.Seconds())

	return checkpoints[len(checkpoints)-1].blockNum, nil
}
