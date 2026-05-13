package main

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"log"
	"math/big"
	"math/rand/v2"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

//go:embed index.html
var indexHTML []byte

const (
	chainID              = uint64(43114)
	defaultListenAddr    = ":9090"
	blockScanInterval    = 1 * time.Second
	balanceInterval      = 60 * time.Second
	gasRefreshInterval   = 10 * time.Second
	gasMultiplierPct     = uint64(120)
	txCostEstimateAvax   = 0.0000002
	gasLimitSelfTransfer = uint64(120_000)
)

type gasPriceCache struct {
	p atomic.Pointer[big.Int]
}

func (g *gasPriceCache) Get() *big.Int { return g.p.Load() }
func (g *gasPriceCache) Set(v *big.Int) { g.p.Store(new(big.Int).Set(v)) }

type pendingTx struct {
	hash     common.Hash
	nonce    uint64
	signTsMs int64
	addedAt  time.Time
}

type tracker struct {
	mu      sync.Mutex
	pending map[common.Hash]pendingTx
}

func newTracker() *tracker {
	return &tracker{pending: make(map[common.Hash]pendingTx)}
}

func (t *tracker) add(p pendingTx) {
	t.mu.Lock()
	t.pending[p.hash] = p
	t.mu.Unlock()
}

func (t *tracker) get(h common.Hash) (pendingTx, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	p, ok := t.pending[h]
	return p, ok
}

func (t *tracker) remove(h common.Hash) {
	t.mu.Lock()
	delete(t.pending, h)
	t.mu.Unlock()
}

func (t *tracker) len() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.pending)
}

func main() {
	cfg, err := LoadConfig()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	wallet, err := LoadWallet(cfg.PrivateKeyHex, chainID)
	if err != nil {
		log.Fatalf("wallet: %v", err)
	}
	addrHex := strings.ToLower(wallet.Address().Hex())
	scanEndpoint := cfg.SendEndpoints[0]

	reg := prometheus.NewRegistry()
	metrics := NewMetrics(reg, cfg.Region, chainID)
	rpc := NewRPCClient()
	tr := newTracker()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Verify chain ID against scan endpoint.
	verifyCtx, verifyCancel := context.WithTimeout(ctx, 10*time.Second)
	observedChainID, err := rpc.ChainID(verifyCtx, scanEndpoint)
	verifyCancel()
	if err != nil {
		log.Fatalf("verify chain id (%s): %v", scanEndpoint, err)
	}
	if observedChainID != chainID {
		log.Fatalf("chain id mismatch: configured %d, endpoint %s reports %d", chainID, scanEndpoint, observedChainID)
	}

	// Initial nonce.
	nonceCtx, nonceCancel := context.WithTimeout(ctx, 10*time.Second)
	startNonce, err := rpc.NonceAt(nonceCtx, scanEndpoint, wallet.Address().Hex(), "pending")
	nonceCancel()
	if err != nil {
		log.Fatalf("initial nonce: %v", err)
	}

	// Initial gas price (cached; refreshed in background so the send path makes zero RPCs).
	var gasPrice gasPriceCache
	gpCtx, gpCancel := context.WithTimeout(ctx, 10*time.Second)
	gp, err := rpc.GasPrice(gpCtx, scanEndpoint)
	gpCancel()
	if err != nil {
		log.Fatalf("initial gas price: %v", err)
	}
	gasPrice.Set(mulPct(gp, gasMultiplierPct))

	// HTTP /metrics server. Honor $PORT (set by Railway etc.); fall back to :9090 locally.
	listenAddr := defaultListenAddr
	if p := os.Getenv("PORT"); p != "" {
		listenAddr = ":" + p
	}
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.HandlerFor(reg, promhttp.HandlerOpts{}))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(indexHTML)
	})
	server := &http.Server{Addr: listenAddr, Handler: mux}
	go func() {
		log.Printf("listening on %s", listenAddr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("http: %v", err)
		}
	}()

	log.Printf("txlat start: region=%s chain_id=%d addr=%s nonce=%d send_endpoints=%d scan_endpoint=%s send_interval=%s",
		cfg.Region, chainID, wallet.Address().Hex(), startNonce, len(cfg.SendEndpoints), scanEndpoint, cfg.SendInterval)

	var wg sync.WaitGroup

	var nonceCounter atomic.Uint64
	nonceCounter.Store(startNonce)

	wg.Add(1)
	go func() {
		defer wg.Done()
		runSender(ctx, cfg, wallet, rpc, tr, metrics, &nonceCounter, &gasPrice)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		runScanner(ctx, cfg, rpc, tr, metrics)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		runBalance(ctx, cfg, rpc, wallet, metrics, addrHex)
	}()

	wg.Add(1)
	go func() {
		defer wg.Done()
		runGasPriceRefresher(ctx, rpc, scanEndpoint, &gasPrice)
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	log.Printf("shutting down")
	cancel()

	shutCtx, shutCancel := context.WithTimeout(context.Background(), 5*time.Second)
	_ = server.Shutdown(shutCtx)
	shutCancel()
	wg.Wait()
}

func runSender(
	ctx context.Context,
	cfg *Config,
	wallet *Wallet,
	rpc *RPCClient,
	tr *tracker,
	metrics *Metrics,
	nonceCounter *atomic.Uint64,
	gasPrice *gasPriceCache,
) {
	jitter := time.Second
	if jitter > cfg.SendInterval {
		jitter = cfg.SendInterval
	}
	for {
		if err := sendOne(ctx, cfg, wallet, rpc, tr, metrics, nonceCounter, gasPrice); err != nil {
			log.Printf("send: %v", err)
		}
		sleep := cfg.SendInterval + rand.N(2*jitter) - jitter
		select {
		case <-ctx.Done():
			return
		case <-time.After(sleep):
		}
	}
}

func runGasPriceRefresher(ctx context.Context, rpc *RPCClient, endpoint string, cache *gasPriceCache) {
	tick := time.NewTicker(gasRefreshInterval)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			c, cancel := context.WithTimeout(ctx, 10*time.Second)
			gp, err := rpc.GasPrice(c, endpoint)
			cancel()
			if err != nil {
				log.Printf("gas price refresh: %v", err)
				continue
			}
			cache.Set(mulPct(gp, gasMultiplierPct))
		}
	}
}

func sendOne(
	ctx context.Context,
	cfg *Config,
	wallet *Wallet,
	rpc *RPCClient,
	tr *tracker,
	metrics *Metrics,
	nonceCounter *atomic.Uint64,
	gasPrice *gasPriceCache,
) error {
	gp := gasPrice.Get()

	nonce := nonceCounter.Add(1) - 1
	signTsMs := time.Now().UnixMilli()
	data := []byte(fmt.Sprintf("benchmark=inclusion-latency tx_sign_ts=%d region=%s", signTsMs, cfg.Region))

	signStart := time.Now()
	signed, err := wallet.BuildAndSign(nonce, gp, gasLimitSelfTransfer, data)
	signDur := time.Since(signStart)
	if err != nil {
		metrics.IncTxSend("sign_error")
		return fmt.Errorf("sign: %w", err)
	}
	if signDur > 2*time.Millisecond {
		log.Printf("WARN: sign took %s (> 2ms) nonce=%d", signDur, nonce)
	}

	tr.add(pendingTx{
		hash:     signed.Hash,
		nonce:    signed.Nonce,
		signTsMs: signTsMs,
		addedAt:  time.Now(),
	})
	metrics.SetPending(tr.len())

	accepted, errors := fanoutSend(ctx, rpc, cfg.SendEndpoints, signed.RawHex)
	if accepted == 0 {
		metrics.IncTxSend("send_failed")
		// Roll back: remove tracking entry so we don't wait forever; also drop nonce reservation.
		tr.remove(signed.Hash)
		metrics.SetPending(tr.len())
		// Reset nonce counter back so we retry with same nonce next tick.
		nonceCounter.CompareAndSwap(nonce+1, nonce)
		return fmt.Errorf("send all endpoints failed: %v", errors)
	}
	metrics.IncTxSend("submitted")
	fmt.Printf(
		"submit region=%s tx_hash=%s nonce=%d tx_sign_ts=%d gas_price_wei=%s accepted=%d/%d\n",
		cfg.Region, signed.Hash.Hex(), signed.Nonce, signTsMs, gp.String(), accepted, len(cfg.SendEndpoints),
	)
	return nil
}

func fanoutSend(ctx context.Context, rpc *RPCClient, endpoints []string, rawHex string) (int, []string) {
	type result struct {
		endpoint string
		err      error
	}
	out := make(chan result, len(endpoints))
	for _, ep := range endpoints {
		go func(ep string) {
			sendCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			defer cancel()
			_, err := rpc.SendRawTransaction(sendCtx, ep, rawHex)
			out <- result{endpoint: ep, err: err}
		}(ep)
	}
	accepted := 0
	var errMsgs []string
	for i := 0; i < len(endpoints); i++ {
		r := <-out
		if r.err == nil || isKnownTxError(r.err) {
			accepted++
		} else {
			errMsgs = append(errMsgs, fmt.Sprintf("%s: %v", r.endpoint, r.err))
		}
	}
	return accepted, errMsgs
}

func isKnownTxError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "already known") ||
		strings.Contains(msg, "already exists") ||
		strings.Contains(msg, "known transaction") ||
		strings.Contains(msg, "nonce too low") ||
		strings.Contains(msg, "replacement transaction underpriced")
}

func runScanner(
	ctx context.Context,
	cfg *Config,
	rpc *RPCClient,
	tr *tracker,
	metrics *Metrics,
) {
	endpoint := cfg.SendEndpoints[0]

	bnCtx, bnCancel := context.WithTimeout(ctx, 10*time.Second)
	startBN, err := rpc.BlockNumber(bnCtx, endpoint)
	bnCancel()
	if err != nil {
		log.Fatalf("scanner: initial block number: %v", err)
	}
	metrics.SetLatestBlock(startBN)
	log.Printf("scanner: starting at block %d", startBN+1)

	n := startBN + 1
	for {
		if ctx.Err() != nil {
			return
		}
		bctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		block, err := rpc.GetBlockByNumber(bctx, endpoint, n)
		cancel()
		if err != nil {
			log.Printf("scanner: block %d: %v", n, err)
			sleepCtx(ctx, 1*time.Second)
			continue
		}
		if block == nil {
			// Caught up to head — wait and retry the same block.
			sleepCtx(ctx, 3*time.Second)
			continue
		}
		processBlock(cfg, tr, metrics, block)
		metrics.SetLatestBlock(block.Number)
		n++
	}
}

func sleepCtx(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

func processBlock(cfg *Config, tr *tracker, metrics *Metrics, block *Block) {
	if tr.len() == 0 {
		return
	}
	for _, hashHex := range block.TxHashes {
		h := common.HexToHash(hashHex)
		p, ok := tr.get(h)
		if !ok {
			continue
		}
		latencyMs := block.TimestampMilliseconds - p.signTsMs
		if latencyMs < 0 {
			latencyMs = 0
		}
		metrics.ObserveInclusionLatency(float64(latencyMs) / 1000.0)
		tr.remove(p.hash)
		fmt.Printf(
			"included region=%s tx_hash=%s nonce=%d tx_sign_ts=%d block_number=%d block_timestamp_ms=%d inclusion_latency_ms=%d\n",
			cfg.Region, p.hash.Hex(), p.nonce, p.signTsMs, block.Number, block.TimestampMilliseconds, latencyMs,
		)
	}
	metrics.SetPending(tr.len())
}

func runBalance(
	ctx context.Context,
	cfg *Config,
	rpc *RPCClient,
	wallet *Wallet,
	metrics *Metrics,
	addrHex string,
) {
	tick := time.NewTicker(balanceInterval)
	defer tick.Stop()
	for {
		bCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		bal, err := rpc.Balance(bCtx, cfg.SendEndpoints[0], wallet.Address().Hex())
		cancel()
		if err != nil {
			log.Printf("balance: %v", err)
		} else {
			avax := weiToAvax(bal)
			metrics.SetBalance(addrHex, avax)
			metrics.SetTxsRemaining(addrHex, avax/txCostEstimateAvax)
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

func weiToAvax(wei *big.Int) float64 {
	if wei == nil {
		return 0
	}
	f := new(big.Float).SetInt(wei)
	f.Quo(f, big.NewFloat(1e18))
	v, _ := f.Float64()
	return v
}

func mulPct(v *big.Int, pct uint64) *big.Int {
	out := new(big.Int).Mul(v, new(big.Int).SetUint64(pct))
	out.Quo(out, big.NewInt(100))
	return out
}
