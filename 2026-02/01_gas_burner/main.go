package main

import (
	"bufio"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"math/rand"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"time"

	"gas-burner/burner"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
)

const (
	defaultRPCHTTP = "https://api.avax.network/ext/bc/C/rpc"
	defaultRPCWS   = "wss://api.avax.network/ext/bc/C/ws"

	stateFile = "/data/state.env"

	burnInterval    = 2 * time.Second
	startIters      = uint64(10_000)
	healthPort      = ":8080"
	minHealthBal    = 0.01 // AVAX
	maxErrorRate    = 0.50
	errorWindowSize = 1 * time.Hour
)

func main() {
	rpcHTTP := defaultRPCHTTP
	if v := os.Getenv("RPC_URL"); v != "" {
		rpcHTTP = v
	}
	rpcWS := defaultRPCWS
	if v := os.Getenv("RPC_WS_URL"); v != "" {
		rpcWS = v
	}
	log.Printf("rpc_http=%s  rpc_ws=%s", rpcHTTP, rpcWS)

	target := 0.0
	if v := os.Getenv("TARGET_NAVAX"); v != "" {
		var err error
		target, err = strconv.ParseFloat(v, 64)
		if err != nil {
			log.Fatalf("invalid TARGET_NAVAX=%q: %v", v, err)
		}
	}

	keyHex := os.Getenv("PRIVATE_KEY")
	if keyHex == "" {
		log.Fatal("PRIVATE_KEY env var is required")
	}
	privateKey, err := crypto.HexToECDSA(strings.TrimPrefix(keyHex, "0x"))
	if err != nil {
		log.Fatalf("invalid PRIVATE_KEY: %v", err)
	}
	fromAddr := crypto.PubkeyToAddress(privateKey.PublicKey)

	httpClient, err := ethclient.Dial(rpcHTTP)
	if err != nil {
		log.Fatalf("HTTP RPC failed: %v", err)
	}
	defer httpClient.Close()

	chainID, err := httpClient.ChainID(context.Background())
	if err != nil {
		log.Fatalf("chain ID failed: %v", err)
	}

	balance, err := httpClient.BalanceAt(context.Background(), fromAddr, nil)
	if err != nil {
		log.Fatalf("balance check failed: %v", err)
	}
	log.Printf("chain=%d  address=%s  balance=%.6f AVAX", chainID, fromAddr.Hex(), weiToAVAX(balance))

	if balance.Cmp(new(big.Int).SetUint64(1e15)) <= 0 {
		fmt.Printf("\n  >>> Fund this address to continue: %s <<<\n\n", fromAddr.Hex())
		return
	}

	auth, err := bind.NewKeyedTransactorWithChainID(privateKey, chainID)
	if err != nil {
		log.Fatalf("transactor failed: %v", err)
	}

	// --- contract: load from persistent state or deploy ---
	contractAddr, selector := setupContract(httpClient, auth)

	if target <= 0 {
		log.Println("Ready. Set TARGET_NAVAX env var to start burning.")
		return
	}

	targetWei := nAvaxToWei(target)
	log.Printf("target=%.2f nAVAX  contract=%s  selector=0x%x", target, contractAddr.Hex(), selector)

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()

	tracker := &gasTracker{}
	errors := newErrorTracker(errorWindowSize)

	go startHealthServer(httpClient, fromAddr, errors)
	go subscribeHeads(ctx, rpcWS, tracker)

	burnLoop(ctx, httpClient, auth, fromAddr, contractAddr, selector, targetWei, tracker, errors)
}

// ---------------------------------------------------------------------------
// Contract setup — load from /data/state.env or deploy a random variant
// ---------------------------------------------------------------------------

func setupContract(client *ethclient.Client, auth *bind.TransactOpts) (common.Address, [4]byte) {
	// try loading persisted state
	if state := loadState(); state != nil {
		addr := common.HexToAddress(state["CONTRACT"])
		selBytes, _ := hex.DecodeString(state["SELECTOR"])
		if len(selBytes) == 4 {
			var sel [4]byte
			copy(sel[:], selBytes)
			log.Printf("contract=%s  selector=0x%s (from %s)", addr.Hex(), state["SELECTOR"], stateFile)
			return addr, sel
		}
	}

	// deploy a random pre-compiled variant
	idx := rand.Intn(len(burner.Variants))
	v := burner.Variants[idx]
	log.Printf("deploying variant %d...", idx)

	// set gas params so deploy tx doesn't get stuck
	auth.GasFeeCap = new(big.Int).SetUint64(100_000_000_000) // 100 nAVAX cap
	auth.GasTipCap = new(big.Int).SetUint64(1_000_000_000)   // 1 nAVAX tip
	auth.GasPrice = nil

	addr, tx, err := burner.Deploy(auth, client, v)
	if err != nil {
		log.Fatalf("deploy failed: %v", err)
	}
	log.Printf("deploy tx=%s  waiting...", tx.Hash().Hex())

	receipt, err := bind.WaitMined(context.Background(), client, tx)
	if err != nil {
		log.Fatalf("deploy confirmation failed: %v", err)
	}
	log.Printf("deployed at %s  block=%d  gas=%d", addr.Hex(), receipt.BlockNumber.Uint64(), receipt.GasUsed)

	// persist to volume
	selHex := hex.EncodeToString(v.Selector[:])
	saveState(map[string]string{"CONTRACT": addr.Hex(), "SELECTOR": selHex})

	return addr, v.Selector
}

func loadState() map[string]string {
	f, err := os.Open(stateFile)
	if err != nil {
		return nil
	}
	defer f.Close()
	state := map[string]string{}
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if ok {
			state[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	return state
}

func saveState(state map[string]string) {
	var sb strings.Builder
	for k, v := range state {
		fmt.Fprintf(&sb, "%s=%s\n", k, v)
	}
	if err := os.WriteFile(stateFile, []byte(sb.String()), 0600); err != nil {
		log.Printf("warning: could not persist state to %s: %v", stateFile, err)
	}
}

// ---------------------------------------------------------------------------
// Error tracker
// ---------------------------------------------------------------------------

type errorTracker struct {
	mu      sync.Mutex
	window  time.Duration
	results []txResult
}

type txResult struct {
	at      time.Time
	success bool
}

func newErrorTracker(window time.Duration) *errorTracker {
	return &errorTracker{window: window}
}

func (e *errorTracker) record(success bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.results = append(e.results, txResult{at: time.Now(), success: success})
	e.prune()
}

func (e *errorTracker) prune() {
	cutoff := time.Now().Add(-e.window)
	i := 0
	for i < len(e.results) && e.results[i].at.Before(cutoff) {
		i++
	}
	e.results = e.results[i:]
}

func (e *errorTracker) rate() (errorRate float64, total int) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.prune()
	total = len(e.results)
	if total == 0 {
		return 0, 0
	}
	errors := 0
	for _, r := range e.results {
		if !r.success {
			errors++
		}
	}
	return float64(errors) / float64(total), total
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

func startHealthServer(client *ethclient.Client, addr common.Address, errors *errorTracker) {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		checks := map[string]any{}
		healthy := true

		balance, err := client.BalanceAt(context.Background(), addr, nil)
		if err != nil {
			checks["balance"] = map[string]any{"ok": false, "error": err.Error()}
			healthy = false
		} else {
			bal := weiToAVAX(balance)
			balOK := bal > minHealthBal
			checks["balance"] = map[string]any{"ok": balOK, "avax": bal, "min_avax": minHealthBal}
			if !balOK {
				healthy = false
			}
		}

		rate, total := errors.rate()
		rateOK := total < 10 || rate < maxErrorRate
		checks["error_rate"] = map[string]any{"ok": rateOK, "rate": rate, "max_rate": maxErrorRate, "total_1h": total}
		if !rateOK {
			healthy = false
		}

		checks["address"] = addr.Hex()
		checks["healthy"] = healthy

		w.Header().Set("Content-Type", "application/json")
		if healthy {
			w.WriteHeader(http.StatusOK)
		} else {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		json.NewEncoder(w).Encode(checks)
	})

	log.Printf("[health] listening on %s", healthPort)
	http.ListenAndServe(healthPort, mux)
}

// ---------------------------------------------------------------------------
// Block subscription via WebSocket — reconnects on failure
// ---------------------------------------------------------------------------

func subscribeHeads(ctx context.Context, wsURL string, tracker *gasTracker) {
	for ctx.Err() == nil {
		err := subscribeOnce(ctx, wsURL, tracker)
		if ctx.Err() != nil {
			return
		}
		log.Printf("[sub] disconnected: %v — reconnecting in 3s", err)
		time.Sleep(3 * time.Second)
	}
}

func subscribeOnce(ctx context.Context, wsURL string, tracker *gasTracker) error {
	client, err := ethclient.Dial(wsURL)
	if err != nil {
		return fmt.Errorf("ws connect: %w", err)
	}
	defer client.Close()

	headers := make(chan *types.Header)
	sub, err := client.SubscribeNewHead(ctx, headers)
	if err != nil {
		return fmt.Errorf("subscribe: %w", err)
	}
	defer sub.Unsubscribe()

	log.Println("[sub] watching blocks")
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-sub.Err():
			return fmt.Errorf("stream: %w", err)
		case head := <-headers:
			if head.BaseFee == nil {
				continue
			}
			tracker.update(head.BaseFee, head.Number.Uint64())
			latest, block, _ := tracker.get()
			log.Printf("[block %d] baseFee=%.2f nAVAX", block, latest/1e9)
		}
	}
}

// ---------------------------------------------------------------------------
// Gas price tracker
// ---------------------------------------------------------------------------

type gasTracker struct {
	mu       sync.RWMutex
	latest   float64
	blockNum uint64
	ready    bool
}

func (t *gasTracker) update(baseFee *big.Int, blockNum uint64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.latest = float64(baseFee.Uint64())
	t.blockNum = blockNum
	t.ready = true
}

func (t *gasTracker) get() (float64, uint64, bool) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.latest, t.blockNum, t.ready
}

// ---------------------------------------------------------------------------
// Burn loop
// ---------------------------------------------------------------------------

func burnLoop(
	ctx context.Context,
	client *ethclient.Client,
	auth *bind.TransactOpts,
	from common.Address,
	contractAddr common.Address,
	sel [4]byte,
	target *big.Int,
	tracker *gasTracker,
	errors *errorTracker,
) {
	targetF := float64(target.Uint64())
	iterations := startIters
	tick := 0

	ticker := time.NewTicker(burnInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Println("shutdown")
			return
		case <-ticker.C:
			tick++

			baseFee, blockNum, ready := tracker.get()
			if !ready {
				continue
			}

			baseFeeNav := baseFee / 1e9
			targetNav := targetF / 1e9
			ratio := baseFee / targetF

			var factor float64
			switch {
			case ratio < 0.5:
				factor = 1.10
			case ratio < 0.90:
				factor = 1.05
			case ratio < 1.10:
				if ratio < 1.0 {
					factor = 1.005
				} else {
					factor = 0.995
				}
			case ratio < 1.30:
				factor = 0.95
			case ratio < 1.50:
				factor = 0.90
			default:
				factor = 0.80
			}
			iterations = clampU64(uint64(float64(iterations)*factor), 100, 10_000_000)

			if ratio >= 1.0 {
				if tick%15 == 0 {
					log.Printf("[hold] block=%d  baseFee=%.2f  target=%.2f nAVAX  iters=%d",
						blockNum, baseFeeNav, targetNav, iterations)
				}
				continue
			}
			if iterations < 1000 {
				if tick%15 == 0 {
					log.Printf("[idle] block=%d  baseFee=%.2f  target=%.2f nAVAX  iters=%d  (too low)",
						blockNum, baseFeeNav, targetNav, iterations)
				}
				continue
			}

			pending, _ := client.PendingNonceAt(ctx, from)
			confirmed, _ := client.NonceAt(ctx, from, nil)
			if pending-confirmed > 3 {
				log.Printf("[skip] %d pending txs", pending-confirmed)
				continue
			}

			auth.Nonce = nil
			auth.GasLimit = 0
			auth.GasFeeCap = target
			tip := big.NewInt(1_000_000_000)
			if tip.Cmp(target) > 0 {
				tip = new(big.Int).Set(target)
			}
			auth.GasTipCap = tip
			auth.GasPrice = nil

			tx, err := burner.Burn(auth, client, contractAddr, sel, iterations)
			if err != nil {
				if strings.Contains(err.Error(), "not found") || strings.Contains(err.Error(), "1559") {
					log.Fatalf("chain does not support EIP-1559: %v", err)
				}
				log.Printf("[burn] failed: %v", err)
				errors.record(false)
				continue
			}

			errors.record(true)
			maxCost := float64(target.Uint64()) * float64(tx.Gas()) / 1e18
			log.Printf("[burn] block=%d  baseFee=%.2f  target=%.2f nAVAX  iters=%d  cost≤%.6f AVAX  tx=%s",
				blockNum, baseFeeNav, targetNav, iterations, maxCost, short(tx.Hash().Hex()))
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func nAvaxToWei(nAvax float64) *big.Int {
	return new(big.Int).SetUint64(uint64(nAvax * 1e9))
}

func weiToAVAX(wei *big.Int) float64 {
	f := new(big.Float).SetInt(wei)
	f.Quo(f, new(big.Float).SetFloat64(1e18))
	v, _ := f.Float64()
	return v
}

func clampU64(v, lo, hi uint64) uint64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func short(s string) string {
	if len(s) > 18 {
		return s[:18] + "..."
	}
	return s
}
