package main

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"math/big"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"time"

	"gas-burner/bindings"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
)

const (
	burnInterval    = 2 * time.Second
	startIters      = uint64(10_000)
	healthPort      = ":8080"
	minHealthBal    = 0.01 // AVAX
	maxErrorRate    = 0.50 // 50%
	errorWindowSize = 1 * time.Hour
)

func main() {
	target := 0.0
	if v := os.Getenv("TARGET_NAVAX"); v != "" {
		var err error
		target, err = strconv.ParseFloat(v, 64)
		if err != nil {
			log.Fatalf("invalid TARGET_NAVAX=%q: %v", v, err)
		}
	}

	env := loadEnv()

	// --- private key: load or generate ---
	privateKey, fromAddr := setupKey(env)

	// --- HTTP client for txs + block data ---
	httpClient, err := ethclient.Dial(env["RPC_HTTP"])
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

	log.Printf("chain=%d  address=%s  balance=%.6f AVAX",
		chainID, fromAddr.Hex(), weiToAVAX(balance))

	minBalance := new(big.Int).SetUint64(1e15) // 0.001 AVAX
	if balance.Cmp(minBalance) <= 0 {
		fmt.Printf("\n  >>> Fund this address to continue: %s <<<\n\n", fromAddr.Hex())
		return
	}

	auth, err := bind.NewKeyedTransactorWithChainID(privateKey, chainID)
	if err != nil {
		log.Fatalf("transactor failed: %v", err)
	}

	// --- contract: deploy if needed ---
	contractAddr := setupContract(env, httpClient, auth)

	if target <= 0 {
		log.Println("Ready. Set TARGET_NAVAX env var to start burning.")
		return
	}

	burner, err := bindings.NewGasBurner(contractAddr, httpClient)
	if err != nil {
		log.Fatalf("contract bind failed: %v", err)
	}

	// --- WS client for block subscriptions ---
	wsURL := env["RPC_WS"]
	targetWei := nAvaxToWei(target)
	log.Printf("target=%.2f nAVAX  contract=%s", target, contractAddr.Hex())

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()

	tracker := &gasTracker{}
	errors := newErrorTracker(errorWindowSize)

	// --- health check endpoint ---
	go startHealthServer(httpClient, fromAddr, errors)

	go subscribeHeads(ctx, wsURL, tracker)

	burnLoop(ctx, httpClient, burner, auth, fromAddr, targetWei, tracker, errors)
}

// ---------------------------------------------------------------------------
// Error tracker — rolling window of success/failure timestamps
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
// Health check HTTP server
// ---------------------------------------------------------------------------

func startHealthServer(client *ethclient.Client, addr common.Address, errors *errorTracker) {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		checks := make(map[string]interface{})
		healthy := true

		// check balance
		balance, err := client.BalanceAt(context.Background(), addr, nil)
		if err != nil {
			checks["balance"] = map[string]interface{}{"ok": false, "error": err.Error()}
			healthy = false
		} else {
			bal := weiToAVAX(balance)
			balOK := bal > minHealthBal
			checks["balance"] = map[string]interface{}{
				"ok":       balOK,
				"avax":     bal,
				"min_avax": minHealthBal,
			}
			if !balOK {
				healthy = false
			}
		}

		// check error rate
		rate, total := errors.rate()
		rateOK := total < 10 || rate < maxErrorRate
		checks["error_rate"] = map[string]interface{}{
			"ok":           rateOK,
			"rate":         rate,
			"max_rate":     maxErrorRate,
			"total_1h":     total,
			"window":       errorWindowSize.String(),
		}
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
	if err := http.ListenAndServe(healthPort, mux); err != nil {
		log.Printf("[health] server failed: %v", err)
	}
}

// ---------------------------------------------------------------------------
// .env management
// ---------------------------------------------------------------------------

func loadEnv() map[string]string {
	env := map[string]string{
		"RPC_HTTP":    "https://api.avax.network/ext/bc/C/rpc",
		"RPC_WS":     "wss://api.avax.network/ext/bc/C/ws",
		"PRIVATE_KEY": "",
		"CONTRACT":    "0x2057741Ff49821F68c81C32928748aF275070fb0",
	}

	// .env file (local dev)
	f, err := os.Open(".env")
	if err == nil {
		scanner := bufio.NewScanner(f)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			k, v, ok := strings.Cut(line, "=")
			if ok {
				env[strings.TrimSpace(k)] = strings.TrimSpace(v)
			}
		}
		f.Close()
	}

	// OS environment variables override .env
	for k := range env {
		if v := os.Getenv(k); v != "" {
			env[k] = v
		}
	}

	return env
}

func saveEnv(env map[string]string) {
	data := fmt.Sprintf("# Gas Burner — edit RPC URLs for your chain\nRPC_HTTP=%s\nRPC_WS=%s\nPRIVATE_KEY=%s\nCONTRACT=%s\n",
		env["RPC_HTTP"], env["RPC_WS"], env["PRIVATE_KEY"], env["CONTRACT"])
	if err := os.WriteFile(".env", []byte(data), 0600); err != nil {
		log.Fatalf("failed to write .env: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Key setup — generates if missing, saves to .env
// ---------------------------------------------------------------------------

func setupKey(env map[string]string) (*ecdsa.PrivateKey, common.Address) {
	keyHex := env["PRIVATE_KEY"]

	if keyHex == "" {
		key, err := crypto.GenerateKey()
		if err != nil {
			log.Fatalf("key generation failed: %v", err)
		}
		keyHex = fmt.Sprintf("%x", crypto.FromECDSA(key))
		env["PRIVATE_KEY"] = keyHex
		saveEnv(env)
		log.Println("Generated new private key → .env")
		return key, crypto.PubkeyToAddress(key.PublicKey)
	}

	key, err := crypto.HexToECDSA(strings.TrimPrefix(keyHex, "0x"))
	if err != nil {
		log.Fatalf("invalid PRIVATE_KEY in .env: %v", err)
	}
	return key, crypto.PubkeyToAddress(key.PublicKey)
}

// ---------------------------------------------------------------------------
// Contract setup — deploys if missing, saves to .env
// ---------------------------------------------------------------------------

func setupContract(env map[string]string, client *ethclient.Client, auth *bind.TransactOpts) common.Address {
	if addr := env["CONTRACT"]; addr != "" {
		a := common.HexToAddress(addr)
		log.Printf("contract=%s (from .env)", a.Hex())
		return a
	}

	log.Println("No CONTRACT in .env — deploying...")
	addr, tx, _, err := bindings.DeployGasBurner(auth, client)
	if err != nil {
		log.Fatalf("deploy failed: %v", err)
	}
	log.Printf("deploy tx=%s  waiting...", tx.Hash().Hex())

	receipt, err := bind.WaitMined(context.Background(), client, tx)
	if err != nil {
		log.Fatalf("deploy confirmation failed: %v", err)
	}
	log.Printf("deployed at %s  block=%d  gas=%d",
		addr.Hex(), receipt.BlockNumber.Uint64(), receipt.GasUsed)

	env["CONTRACT"] = addr.Hex()
	saveEnv(env)
	return addr
}

// ---------------------------------------------------------------------------
// Gas price tracker (fed by WS block subscription)
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

func (t *gasTracker) get() (latest float64, blockNum uint64, ready bool) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.latest, t.blockNum, t.ready
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
			baseFee := head.BaseFee
			if baseFee == nil {
				continue
			}
			tracker.update(baseFee, head.Number.Uint64())
			latest, block, _ := tracker.get()
			log.Printf("[block %d] baseFee=%.2f nAVAX",
				block, latest/1e9)
		}
	}
}

// ---------------------------------------------------------------------------
// Burn loop — steady cadence, reads tracker, sends txs via HTTP
// ---------------------------------------------------------------------------

func burnLoop(
	ctx context.Context,
	client *ethclient.Client,
	burner *bindings.GasBurner,
	auth *bind.TransactOpts,
	from common.Address,
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
			ratio := baseFee / targetF // <1 = below target, >1 = above

			// adjust iterations proportionally to distance from target
			var factor float64
			switch {
			case ratio < 0.5:
				factor = 1.10 // way below → aggressive ramp
			case ratio < 0.90:
				factor = 1.05 // below → moderate ramp
			case ratio < 1.10:
				// in the ±10% zone — tiny nudges (anti-oscillation buffer)
				if ratio < 1.0 {
					factor = 1.005
				} else {
					factor = 0.995
				}
			case ratio < 1.30:
				factor = 0.95 // above → moderate cut
			case ratio < 1.50:
				factor = 0.90 // well above → firm cut
			default:
				factor = 0.80 // way above → aggressive cut
			}
			iterations = clampU64(uint64(float64(iterations)*factor), 100, 10_000_000)

			// above target — don't send, we're keeping a floor not a ceiling
			if ratio >= 1.0 {
				if tick%15 == 0 {
					log.Printf("[hold] block=%d  baseFee=%.2f  target=%.2f nAVAX  iters=%d",
						blockNum, baseFeeNav, targetNav, iterations)
				}
				continue
			}
			if iterations < 1000 {
				if tick%15 == 0 {
					log.Printf("[idle] block=%d  baseFee=%.2f  target=%.2f nAVAX  iters=%d  (iters too low)",
						blockNum, baseFeeNav, targetNav, iterations)
				}
				continue
			}

			// too many pending — skip
			pending, _ := client.PendingNonceAt(ctx, from)
			confirmed, _ := client.NonceAt(ctx, from, nil)
			if pending-confirmed > 3 {
				log.Printf("[skip] %d pending txs", pending-confirmed)
				continue
			}

			// send burn tx
			auth.Nonce = nil
			auth.GasLimit = 0
			auth.GasFeeCap = target
			tip := big.NewInt(1_000_000_000)
			if tip.Cmp(target) > 0 {
				tip = new(big.Int).Set(target)
			}
			auth.GasTipCap = tip
			auth.GasPrice = nil

			tx, err := burner.Burn(auth, new(big.Int).SetUint64(iterations))
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

func clamp(v, lo, hi float64) float64 {
	return math.Max(lo, math.Min(v, hi))
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
