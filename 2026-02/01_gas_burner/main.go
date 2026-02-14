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
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/joho/godotenv"
)

const (
	defaultRPC = "https://api.avax.network/ext/bc/C/rpc"
	stateFile  = "/data/state.env"

	defaultBurnInterval = 1500 * time.Millisecond
	healthPort      = ":8080"
	minHealthBal    = 0.01 // AVAX
	maxErrorRate    = 0.50
	errorWindowSize = 1 * time.Hour
)

func main() {
	_ = godotenv.Load()
	rpcURL := defaultRPC
	if v := os.Getenv("RPC_URL"); v != "" {
		rpcURL = v
	}
	log.Printf("rpc=%s", rpcURL)

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

	httpClient, err := ethclient.Dial(rpcURL)
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

	interval := defaultBurnInterval
	if v := os.Getenv("BURN_INTERVAL_MS"); v != "" {
		ms, err := strconv.Atoi(v)
		if err != nil {
			log.Fatalf("invalid BURN_INTERVAL_MS=%q: %v", v, err)
		}
		interval = time.Duration(ms) * time.Millisecond
	}

	log.Printf("target=%.2f nAVAX  interval=%s  contract=%s  selector=0x%x", target, interval, contractAddr.Hex(), selector)

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()

	errors := newErrorTracker(errorWindowSize)

	go startHealthServer(httpClient, fromAddr, errors)

	burnLoop(ctx, httpClient, auth, fromAddr, contractAddr, selector, targetWei, interval, errors)
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

	// deploy a random variant (unique selector each time)
	v := burner.RandomVariant()
	log.Printf("deploying variant 0x%x...", v.Selector)

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
// Burn loop — polls base fee via HTTP, no WebSocket needed
// ---------------------------------------------------------------------------

func burnLoop(
	ctx context.Context,
	client *ethclient.Client,
	auth *bind.TransactOpts,
	from common.Address,
	contractAddr common.Address,
	sel [4]byte,
	target *big.Int,
	interval time.Duration,
	errors *errorTracker,
) {
	targetF := float64(target.Uint64())
	lastLog := time.Time{}

	for {
		loopStart := time.Now()

		if ctx.Err() != nil {
			log.Println("shutdown")
			return
		}

		head, err := client.HeaderByNumber(ctx, nil)
		if err != nil {
			log.Printf("[poll] header fetch failed: %v", err)
			sleepRemaining(loopStart, interval, ctx)
			continue
		}
		if head.BaseFee == nil {
			log.Printf("[poll] block %d has no baseFee", head.Number.Uint64())
			sleepRemaining(loopStart, interval, ctx)
			continue
		}

		baseFee := float64(head.BaseFee.Uint64())
		blockNum := head.Number.Uint64()
		baseFeeNav := baseFee / 1e9
		targetNav := targetF / 1e9
		ratio := baseFee / targetF

		// at or above target — fee cap will prevent inclusion anyway
		if ratio >= 1.0 {
			if time.Since(lastLog) > 2*time.Minute {
				log.Printf("[hold] block=%d  baseFee=%.4f  target=%.4f nAVAX", blockNum, baseFeeNav, targetNav)
				lastLog = time.Now()
			}
			sleepRemaining(loopStart, interval, ctx)
			continue
		}

		// pick gas limit: aggressive — ±20% jitter
		var baseGas uint64
		if ratio < 0.90 {
			baseGas = 16_000_000
		} else {
			baseGas = 8_000_000
		}
		jitter := 0.8 + rand.Float64()*0.4 // [0.8, 1.2)
		gasLimit := uint64(float64(baseGas) * jitter)

		// one tx in flight at a time
		pending, _ := client.PendingNonceAt(ctx, from)
		confirmed, _ := client.NonceAt(ctx, from, nil)
		if pending > confirmed {
			sleepRemaining(loopStart, interval, ctx)
			continue
		}

		auth.Nonce = nil
		auth.GasLimit = gasLimit // hardcoded — estimateGas will fail (INVALID always reverts)
		auth.GasFeeCap = target
		tip := big.NewInt(1_000_000_000)
		if tip.Cmp(target) > 0 {
			tip = new(big.Int).Set(target)
		}
		auth.GasTipCap = tip
		auth.GasPrice = nil

		tx, err := burner.Burn(auth, client, contractAddr, sel)
		if err != nil {
			if strings.Contains(err.Error(), "not found") || strings.Contains(err.Error(), "1559") {
				log.Fatalf("chain does not support EIP-1559: %v", err)
			}
			log.Printf("[burn] failed: %v", err)
			errors.record(false)
			sleepRemaining(loopStart, interval, ctx)
			continue
		}

		errors.record(true)
		maxCost := float64(target.Uint64()) * float64(tx.Gas()) / 1e18
		log.Printf("[burn] block=%d  baseFee=%.4f  target=%.4f nAVAX  gas=%.1fM  cost≤%.6f AVAX  tx=%s",
			blockNum, baseFeeNav, targetNav, float64(gasLimit)/1e6, maxCost, tx.Hash().Hex())

		sleepRemaining(loopStart, interval, ctx)
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func sleepRemaining(start time.Time, interval time.Duration, ctx context.Context) {
	elapsed := time.Since(start)
	if remaining := interval - elapsed; remaining > 0 {
		select {
		case <-time.After(remaining):
		case <-ctx.Done():
		}
	}
}

func nAvaxToWei(nAvax float64) *big.Int {
	return new(big.Int).SetUint64(uint64(nAvax * 1e9))
}

func weiToAVAX(wei *big.Int) float64 {
	f := new(big.Float).SetInt(wei)
	f.Quo(f, new(big.Float).SetFloat64(1e18))
	v, _ := f.Float64()
	return v
}
