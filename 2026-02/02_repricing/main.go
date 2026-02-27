package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"math"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/ava-labs/libevm/common"
	"github.com/ava-labs/libevm/core"
	"github.com/ava-labs/libevm/core/types"
	"github.com/ava-labs/libevm/core/vm"
	"github.com/ava-labs/libevm/params"
	"github.com/holiman/uint256"
)

const replayBlockWorkers = 8

var (
	flagBlock           = flag.Uint64("block", 0, "single block to replay")
	flagFrom            = flag.Uint64("from", 0, "block range start")
	flagTo              = flag.Uint64("to", 0, "block range end (inclusive)")
	flagCacheDir        = flag.String("cache", "cache/blocks", "unused (cache disabled)")
	flagVerbose         = flag.Bool("v", false, "verbose output")
	flagProfile         = flag.String("profile", "baseline", "profile name for output labeling")
	flagSStoreSetMult   = flag.Float64("sstore-set-mult", 1.0, "multiplier for SSTORE clean zero->non-zero cost")
	flagCreate2Mult     = flag.Float64("create2-mult", 1.0, "multiplier for CREATE2 base cost")
	flagSkipUnsupported = flag.Bool("skip-unsupported-precompiles", true, "exclude unsupported Avalanche precompile txs from mismatch stats")
	flagOut             = flag.String("out", "", "path to JSONL tx results (default: out/replay_<profile>_<from>_<to>.jsonl)")
	flagOutSummary      = flag.String("out-summary", "", "path to JSON summary (default: out/replay_<profile>_<from>_<to>_summary.json)")
	flagDebug           = flag.Bool("debug", false, "debug mode")
)

type ReplayTxResult struct {
	BlockNumber      uint64 `json:"block_number"`
	TxIndex          int    `json:"tx_index"`
	TxHash           string `json:"tx_hash"`
	UnsupportedTx    bool   `json:"unsupported_tx"`
	SkippedCompare   bool   `json:"skipped_compare"`
	SkipReason       string `json:"skip_reason,omitempty"`
	CanonStatus      uint64 `json:"canon_status"`
	ReplayStatus     uint64 `json:"replay_status"`
	StatusChanged    bool   `json:"status_changed"`
	CanonGasUsed     uint64 `json:"canon_gas_used"`
	ReplayGasUsed    uint64 `json:"replay_gas_used"`
	GasDelta         int64  `json:"gas_delta"`
	GasMismatch      bool   `json:"gas_mismatch"`
	CanonLogs        int    `json:"canon_logs"`
	ReplayLogs       int    `json:"replay_logs"`
	LogsChanged      bool   `json:"logs_changed"`
	LogsDiffReason   string `json:"logs_diff_reason,omitempty"`
	LogCompareError  string `json:"log_compare_error,omitempty"`
	ExecutionError   string `json:"execution_error,omitempty"`
	ParentStateBlock uint64 `json:"parent_state_block"`
	Profile          string `json:"profile"`
}

type blockReplayResult struct {
	blockNum uint64
	err      error

	rows []ReplayTxResult

	txTotal            int
	executed           int
	compared           int
	skippedUnsupported int
	statusChanged      int
	successToRevert    int
	revertToSuccess    int
	gasMismatches      int
	gasDeltaSum        int64
	gasIncreaseCount   int
	gasIncreaseSum     int64
	logsChanged        int
	blockGasLimitAtTx  int
	blockedTxs         int
	rpcCalls           int64
	elapsed            time.Duration

	comparisonPrintRows []string
}

type replayRunConfig struct {
	chainCfg        *params.ChainConfig
	chainID         *big.Int
	profile         string
	verbose         bool
	skipUnsupported bool
	cacheDir        string
}

// C-Chain mainnet config (all forks active for blocks > 3.3M).
func cchainConfig() *params.ChainConfig {
	return &params.ChainConfig{
		ChainID:             big.NewInt(43114),
		HomesteadBlock:      big.NewInt(0),
		DAOForkBlock:        big.NewInt(0),
		DAOForkSupport:      true,
		EIP150Block:         big.NewInt(0),
		EIP155Block:         big.NewInt(0),
		EIP158Block:         big.NewInt(0),
		ByzantiumBlock:      big.NewInt(0),
		ConstantinopleBlock: big.NewInt(0),
		PetersburgBlock:     big.NewInt(0),
		IstanbulBlock:       big.NewInt(0),
		MuirGlacierBlock:    big.NewInt(0),
		BerlinBlock:         big.NewInt(0),
		LondonBlock:         big.NewInt(0),
		ShanghaiTime:        ptrU64(0),
		CancunTime:          ptrU64(0),
	}
}

func main() {
	flag.Parse()

	if *flagDebug {
		if *flagBlock == 0 {
			fmt.Fprintln(os.Stderr, "need -block")
			os.Exit(1)
		}
		_ = os.MkdirAll(*flagCacheDir, 0o755)
		debugBlock(*flagBlock, *flagCacheDir)
		return
	}

	from, to := *flagFrom, *flagTo
	if *flagBlock != 0 {
		from, to = *flagBlock, *flagBlock
	}
	if from == 0 || to == 0 || to < from {
		fmt.Fprintln(os.Stderr, "Usage: replay -block N  or  -from N -to M")
		os.Exit(1)
	}

	sstoreSetGas, err := scaledGas(params.SstoreSetGasEIP2200, *flagSStoreSetMult)
	if err != nil {
		fmt.Fprintf(os.Stderr, "invalid -sstore-set-mult: %v\n", err)
		os.Exit(1)
	}
	create2Gas, err := scaledGas(params.Create2Gas, *flagCreate2Mult)
	if err != nil {
		fmt.Fprintf(os.Stderr, "invalid -create2-mult: %v\n", err)
		os.Exit(1)
	}
	vm.SetReplayGasSchedule(sstoreSetGas, create2Gas)

	outPath := *flagOut
	if outPath == "" {
		outPath = defaultOutPath(*flagProfile, from, to, false)
	}
	summaryPath := *flagOutSummary
	if summaryPath == "" {
		summaryPath = defaultOutPath(*flagProfile, from, to, true)
	}
	if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "create out dir failed: %v\n", err)
		os.Exit(1)
	}
	if err := os.MkdirAll(filepath.Dir(summaryPath), 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "create summary dir failed: %v\n", err)
		os.Exit(1)
	}

	outFile, err := os.Create(outPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "open out file failed: %v\n", err)
		os.Exit(1)
	}
	defer outFile.Close()
	outWriter := bufio.NewWriter(outFile)
	defer outWriter.Flush()
	jsonEncoder := json.NewEncoder(outWriter)
	jsonEncoder.SetEscapeHTML(false)

	chainCfg := cchainConfig()
	cfg := replayRunConfig{
		chainCfg:        chainCfg,
		chainID:         chainCfg.ChainID,
		profile:         *flagProfile,
		verbose:         *flagVerbose,
		skipUnsupported: *flagSkipUnsupported,
		cacheDir:        *flagCacheDir,
	}

	startAll := time.Now()
	resultsByBlock := replayBlocksParallel(from, to, cfg)

	var totalExecuted int
	var totalCompared int
	var totalStatusChanged int
	var totalSuccessToRevert int
	var totalRevertToSuccess int
	var totalGasMismatch int
	var totalGasDeltaSum int64
	var totalGasIncreaseCount int
	var totalGasIncreaseSum int64
	var totalLogsChanged int
	var totalSkippedUnsupported int
	var totalBlockedTxs int

	for blockNum := from; blockNum <= to; blockNum++ {
		res, ok := resultsByBlock[blockNum]
		if !ok {
			fatalf("missing result for block %d", blockNum)
		}
		if res.err != nil {
			fatalf("block %d error: %v", blockNum, res.err)
		}

		for _, line := range res.comparisonPrintRows {
			fmt.Println(line)
		}
		for _, row := range res.rows {
			_ = jsonEncoder.Encode(row)
		}
		_ = outWriter.Flush()

		fmt.Fprintln(os.Stderr, formatBlockStatusLine(res))

		totalExecuted += res.executed
		totalCompared += res.compared
		totalStatusChanged += res.statusChanged
		totalSuccessToRevert += res.successToRevert
		totalRevertToSuccess += res.revertToSuccess
		totalGasMismatch += res.gasMismatches
		totalGasDeltaSum += res.gasDeltaSum
		totalGasIncreaseCount += res.gasIncreaseCount
		totalGasIncreaseSum += res.gasIncreaseSum
		totalLogsChanged += res.logsChanged
		totalSkippedUnsupported += res.skippedUnsupported
		totalBlockedTxs += res.blockedTxs
	}

	elapsed := time.Since(startAll)
	fmt.Fprintf(os.Stderr, "\n=== Summary ===\n")
	fmt.Fprintf(os.Stderr, "Blocks: %d-%d\n", from, to)
	fmt.Fprintf(os.Stderr, "Profile: %s\n", *flagProfile)
	fmt.Fprintf(os.Stderr, "RPC WS: %s (%d conns)\n", hardcodedRPCWSURL, wsParallelConnections)
	fmt.Fprintf(os.Stderr, "Block workers: %d\n", replayBlockWorkers)
	fmt.Fprintf(os.Stderr, "SSTORE set gas: %d (base=%d, mult=%.4f)\n", sstoreSetGas, params.SstoreSetGasEIP2200, *flagSStoreSetMult)
	fmt.Fprintf(os.Stderr, "CREATE2 base gas: %d (base=%d, mult=%.4f)\n", create2Gas, params.Create2Gas, *flagCreate2Mult)
	fmt.Fprintf(os.Stderr, "Total executed txs: %d\n", totalExecuted)
	fmt.Fprintf(os.Stderr, "Compared txs: %d\n", totalCompared)
	fmt.Fprintf(os.Stderr, "Skipped unsupported txs: %d\n", totalSkippedUnsupported)
	fmt.Fprintf(os.Stderr, "Not executed (block gas limit reached): %d\n", totalBlockedTxs)
	if totalStatusChanged == 0 {
		fmt.Fprintf(os.Stderr, "Status: okay\n")
	} else {
		fmt.Fprintf(os.Stderr, "Status changes: %d (✅→❌ %d, ❌→✅ %d)\n", totalStatusChanged, totalSuccessToRevert, totalRevertToSuccess)
	}
	if totalLogsChanged == 0 {
		fmt.Fprintf(os.Stderr, "Logs: okay\n")
	} else {
		fmt.Fprintf(os.Stderr, "Logs changed: %d\n", totalLogsChanged)
	}
	if totalGasMismatch == 0 {
		fmt.Fprintf(os.Stderr, "Gas: okay\n")
	} else {
		fmt.Fprintf(os.Stderr, "Gas mismatches: %d\n", totalGasMismatch)
	}
	fmt.Fprintf(os.Stderr, "Avg gas delta (all compared): %.2f\n", avgInt64(totalGasDeltaSum, totalCompared))
	fmt.Fprintf(os.Stderr, "Avg gas increase (delta>0): %.2f\n", avgInt64(totalGasIncreaseSum, totalGasIncreaseCount))
	fmt.Fprintf(os.Stderr, "Elapsed: %s\n", elapsed.Round(time.Millisecond))

	summary := map[string]any{
		"from":                    from,
		"to":                      to,
		"profile":                 *flagProfile,
		"rpc_ws":                  hardcodedRPCWSURL,
		"rpc_ws_connections":      wsParallelConnections,
		"block_workers":           replayBlockWorkers,
		"sstore_set_multiplier":   *flagSStoreSetMult,
		"create2_multiplier":      *flagCreate2Mult,
		"sstore_set_gas":          sstoreSetGas,
		"create2_gas":             create2Gas,
		"total_executed_txs":      totalExecuted,
		"total_compared_txs":      totalCompared,
		"skipped_unsupported_txs": totalSkippedUnsupported,
		"not_executed_txs":        totalBlockedTxs,
		"status_changes":          totalStatusChanged,
		"success_to_revert":       totalSuccessToRevert,
		"revert_to_success":       totalRevertToSuccess,
		"logs_changed":            totalLogsChanged,
		"gas_mismatches":          totalGasMismatch,
		"avg_gas_delta":           avgInt64(totalGasDeltaSum, totalCompared),
		"avg_gas_increase":        avgInt64(totalGasIncreaseSum, totalGasIncreaseCount),
		"elapsed_ms":              elapsed.Milliseconds(),
		"out_jsonl":               outPath,
	}
	summaryJSON, _ := json.MarshalIndent(summary, "", "  ")
	_ = os.WriteFile(summaryPath, summaryJSON, 0o644)
	fmt.Fprintf(os.Stderr, "Summary JSON: %s\n", summaryPath)
}

func replayBlocksParallel(from uint64, to uint64, cfg replayRunConfig) map[uint64]blockReplayResult {
	total := int(to-from) + 1
	workers := replayBlockWorkers
	if workers > total {
		workers = total
	}

	jobs := make(chan uint64, total)
	results := make(chan blockReplayResult, total)

	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for blockNum := range jobs {
				results <- replayOneBlock(blockNum, cfg)
			}
		}()
	}

	for blockNum := from; blockNum <= to; blockNum++ {
		jobs <- blockNum
	}
	close(jobs)

	go func() {
		wg.Wait()
		close(results)
	}()

	byBlock := make(map[uint64]blockReplayResult, total)
	for res := range results {
		byBlock[res.blockNum] = res
	}
	return byBlock
}

func replayOneBlock(blockNum uint64, cfg replayRunConfig) blockReplayResult {
	startBlock := time.Now()
	parentBlock := blockNum - 1
	res := blockReplayResult{blockNum: blockNum, blockGasLimitAtTx: -1}

	rpc := NewRPCClient(parentBlock)
	bd, err := LoadOrFetchBlock(rpc, blockNum, cfg.cacheDir)
	if err != nil {
		fatalf("block %d fetch error: %v", blockNum, err)
	}

	header, txs, canonReceipts, err := ParseBlock(bd, cfg.chainID)
	if err != nil {
		fatalf("block %d parse error: %v", blockNum, err)
	}
	if len(txs) != len(canonReceipts) {
		fatalf("block %d tx/receipt count mismatch (%d vs %d)", blockNum, len(txs), len(canonReceipts))
	}

	state := NewReplayState(rpc)
	random := common.Hash{1}
	blockCtx := vm.BlockContext{
		CanTransfer: core.CanTransfer,
		Transfer:    core.Transfer,
		GetHash: func(n uint64) common.Hash {
			return rpc.FetchBlockHash(n)
		},
		Coinbase:    header.Coinbase,
		BlockNumber: header.Number,
		Time:        header.Time,
		Difficulty:  big.NewInt(0),
		Random:      &random,
		BaseFee:     header.BaseFee,
		GasLimit:    header.GasLimit,
	}

	signer := types.NewLondonSigner(cfg.chainID)
	gasPool := new(core.GasPool).AddGas(header.GasLimit)

	res.txTotal = len(txs)
	for i, tx := range txs {
		state.BeginTx(tx.Hash(), i)

		msg, err := core.TransactionToMessage(tx, signer, header.BaseFee)
		if err != nil {
			fatalf("block %d tx %d (%s) message error: %v", blockNum, i, tx.Hash().Hex(), err)
		}

		txCtx := vm.TxContext{Origin: msg.From, GasPrice: msg.GasPrice}
		evm := vm.NewEVM(blockCtx, txCtx, state, cfg.chainCfg, vm.Config{})

		execResult, err := core.ApplyMessage(evm, msg, gasPool)
		if err != nil {
			if errors.Is(err, core.ErrGasLimitReached) {
				res.blockGasLimitAtTx = i
				res.blockedTxs = len(txs) - i
				res.comparisonPrintRows = append(res.comparisonPrintRows,
					fmt.Sprintf("⚠ block=%d gas limit reached at tx=%d; marking remaining %d txs as not executed", blockNum, i, res.blockedTxs))
				appendNotExecutedRows(&res, txs, canonReceipts, i, blockNum, parentBlock, cfg)
				break
			}
			fatalf("block %d tx %d (%s) apply error: %v", blockNum, i, tx.Hash().Hex(), err)
		}

		if execResult.RefundedGas > 0 {
			refundValue := new(uint256.Int).SetUint64(execResult.RefundedGas)
			gasPrice := uint256.MustFromBig(msg.GasPrice)
			refundValue.Mul(refundValue, gasPrice)
			state.SubBalance(msg.From, refundValue)
			state.AddBalance(blockCtx.Coinbase, refundValue)
			gasPool.SubGas(execResult.RefundedGas)
			execResult.UsedGas += execResult.RefundedGas
			execResult.RefundedGas = 0
		}

		state.CommitTx()
		res.executed++

		canon := canonReceipts[i]
		canonStatus := canon.StatusUint()
		replayStatus := uint64(1)
		if execResult.Failed() {
			replayStatus = 0
		}
		canonGas := hexToUint64(canon.GasUsed)
		replayGas := execResult.UsedGas
		gasDelta := int64(replayGas) - int64(canonGas)
		statusChanged := canonStatus != replayStatus
		gasMismatch := gasDelta != 0
		unsupportedTx := isUnsupportedPrecompileTx(tx)
		skippedCompare := cfg.skipUnsupported && unsupportedTx

		replayLogs := state.GetLogs()
		logsChanged, logsDiffReason, logsCompareErr := compareReceiptLogs(canon.Logs, replayLogs)

		row := ReplayTxResult{
			BlockNumber:      blockNum,
			TxIndex:          i,
			TxHash:           tx.Hash().Hex(),
			UnsupportedTx:    unsupportedTx,
			SkippedCompare:   skippedCompare,
			CanonStatus:      canonStatus,
			ReplayStatus:     replayStatus,
			StatusChanged:    statusChanged,
			CanonGasUsed:     canonGas,
			ReplayGasUsed:    replayGas,
			GasDelta:         gasDelta,
			GasMismatch:      gasMismatch,
			CanonLogs:        len(canon.Logs),
			ReplayLogs:       len(replayLogs),
			LogsChanged:      logsChanged,
			LogsDiffReason:   logsDiffReason,
			ParentStateBlock: parentBlock,
			Profile:          cfg.profile,
		}
		if logsCompareErr != nil {
			row.LogCompareError = logsCompareErr.Error()
			fatalf("block %d tx %d (%s) log compare error: %v", blockNum, i, tx.Hash().Hex(), logsCompareErr)
		}
		if skippedCompare {
			row.SkipReason = "unsupported_precompile_tx"
		}
		res.rows = append(res.rows, row)

		if skippedCompare {
			res.skippedUnsupported++
			if cfg.verbose {
				res.comparisonPrintRows = append(res.comparisonPrintRows,
					fmt.Sprintf("~ block=%d tx=%d hash=%s skipped=unsupported_precompile canon_status=%d replay_status=%d canon_gas=%d replay_gas=%d delta=%+d logs_changed=%v logs_reason=%s",
						blockNum, i, tx.Hash().Hex()[:18], canonStatus, replayStatus, canonGas, replayGas, gasDelta, logsChanged, logsDiffReason))
			}
			continue
		}

		res.compared++
		res.gasDeltaSum += gasDelta
		if gasDelta > 0 {
			res.gasIncreaseCount++
			res.gasIncreaseSum += gasDelta
		}
		if statusChanged {
			res.statusChanged++
			if canonStatus == 1 && replayStatus == 0 {
				res.successToRevert++
			} else if canonStatus == 0 && replayStatus == 1 {
				res.revertToSuccess++
			}
		}
		if gasMismatch {
			res.gasMismatches++
		}
		if logsChanged {
			res.logsChanged++
		}
		if statusChanged || logsChanged || (cfg.verbose && gasMismatch) {
			marker := " "
			if statusChanged {
				marker = "!"
			} else if logsChanged {
				marker = "ℹ"
			}
			res.comparisonPrintRows = append(res.comparisonPrintRows,
				fmt.Sprintf("%s block=%d tx=%d hash=%s canon_status=%d replay_status=%d canon_gas=%d replay_gas=%d delta=%+d logs_changed=%v logs_reason=%s",
					marker, blockNum, i, tx.Hash().Hex()[:18], canonStatus, replayStatus, canonGas, replayGas, gasDelta, logsChanged, logsDiffReason))
		}
	}

	res.rpcCalls = rpc.rpcCalls.Load()
	res.elapsed = time.Since(startBlock)
	return res
}

func scaledGas(base uint64, mult float64) (uint64, error) {
	if mult < 1.0 {
		return 0, fmt.Errorf("multiplier must be >= 1.0")
	}
	scaled := uint64(math.Round(float64(base) * mult))
	if scaled == 0 {
		return 0, fmt.Errorf("scaled gas is zero")
	}
	return scaled, nil
}

func defaultOutPath(profile string, from uint64, to uint64, summary bool) string {
	suffix := ".jsonl"
	if summary {
		suffix = "_summary.json"
	}
	return fmt.Sprintf("out/replay_%s_%d_%d%s", profile, from, to, suffix)
}

func isUnsupportedPrecompileTx(tx *types.Transaction) bool {
	if to := tx.To(); to != nil && isAvalancheSystemPrecompile(*to) {
		return true
	}
	for _, entry := range tx.AccessList() {
		if isAvalancheSystemPrecompile(entry.Address) {
			return true
		}
	}
	return false
}

func isAvalancheSystemPrecompile(addr common.Address) bool {
	if addr[0] != 0x01 && addr[0] != 0x02 {
		return false
	}
	for i := 1; i < len(addr)-1; i++ {
		if addr[i] != 0 {
			return false
		}
	}
	return true
}

type canonLogComparable struct {
	Address string
	Topics  []string
	Data    string
}

func compareReceiptLogs(canonRaw []json.RawMessage, replayLogs []*types.Log) (bool, string, error) {
	canonLogs := make([]canonLogComparable, 0, len(canonRaw))
	for i, raw := range canonRaw {
		var l struct {
			Address string   `json:"address"`
			Topics  []string `json:"topics"`
			Data    string   `json:"data"`
		}
		if err := json.Unmarshal(raw, &l); err != nil {
			return true, fmt.Sprintf("canon_unmarshal[%d]", i), err
		}
		topics := make([]string, 0, len(l.Topics))
		for _, t := range l.Topics {
			topics = append(topics, normalizeHex(t))
		}
		canonLogs = append(canonLogs, canonLogComparable{
			Address: normalizeHex(l.Address),
			Topics:  topics,
			Data:    normalizeHex(l.Data),
		})
	}

	if len(canonLogs) != len(replayLogs) {
		return true, "count", nil
	}

	for i := range canonLogs {
		replayAddress := normalizeHex(replayLogs[i].Address.Hex())
		if canonLogs[i].Address != replayAddress {
			return true, fmt.Sprintf("address[%d]", i), nil
		}
		if len(canonLogs[i].Topics) != len(replayLogs[i].Topics) {
			return true, fmt.Sprintf("topics_count[%d]", i), nil
		}
		for j := range canonLogs[i].Topics {
			replayTopic := normalizeHex(replayLogs[i].Topics[j].Hex())
			if canonLogs[i].Topics[j] != replayTopic {
				return true, fmt.Sprintf("topic[%d][%d]", i, j), nil
			}
		}
		replayData := normalizeHex(fmt.Sprintf("0x%x", replayLogs[i].Data))
		if canonLogs[i].Data != replayData {
			return true, fmt.Sprintf("data[%d]", i), nil
		}
	}

	return false, "", nil
}

func normalizeHex(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "0x"
	}
	if strings.HasPrefix(s, "0x") || strings.HasPrefix(s, "0X") {
		return "0x" + strings.ToLower(s[2:])
	}
	return "0x" + strings.ToLower(s)
}

func appendNotExecutedRows(
	res *blockReplayResult,
	txs []*types.Transaction,
	canonReceipts []TxReceipt,
	startIdx int,
	blockNum uint64,
	parentBlock uint64,
	cfg replayRunConfig,
) {
	for j := startIdx; j < len(txs); j++ {
		tx := txs[j]
		canon := canonReceipts[j]
		canonStatus := canon.StatusUint()
		canonGas := hexToUint64(canon.GasUsed)
		unsupportedTx := isUnsupportedPrecompileTx(tx)
		skippedCompare := cfg.skipUnsupported && unsupportedTx
		logsChanged := len(canon.Logs) > 0

		row := ReplayTxResult{
			BlockNumber:      blockNum,
			TxIndex:          j,
			TxHash:           tx.Hash().Hex(),
			UnsupportedTx:    unsupportedTx,
			SkippedCompare:   skippedCompare,
			CanonStatus:      canonStatus,
			ReplayStatus:     0,
			StatusChanged:    canonStatus != 0,
			CanonGasUsed:     canonGas,
			ReplayGasUsed:    0,
			GasDelta:         -int64(canonGas),
			GasMismatch:      canonGas != 0,
			CanonLogs:        len(canon.Logs),
			ReplayLogs:       0,
			LogsChanged:      logsChanged,
			LogsDiffReason:   "not_executed_block_gas_limit",
			ExecutionError:   "not executed: block gas limit reached",
			ParentStateBlock: parentBlock,
			Profile:          cfg.profile,
		}
		if skippedCompare {
			row.SkipReason = "unsupported_precompile_tx"
		}
		res.rows = append(res.rows, row)

		if skippedCompare {
			res.skippedUnsupported++
			continue
		}

		res.compared++
		res.gasDeltaSum += row.GasDelta
		if row.StatusChanged {
			res.statusChanged++
			res.successToRevert++
		}
		if row.GasMismatch {
			res.gasMismatches++
		}
		if row.LogsChanged {
			res.logsChanged++
		}
	}
}

func avgInt64(sum int64, count int) float64 {
	if count == 0 {
		return 0
	}
	return float64(sum) / float64(count)
}

func blockHealthEmoji(res blockReplayResult) string {
	if res.statusChanged > 0 || res.logsChanged > 0 {
		return "🔴"
	}
	return "🟢"
}

func formatBlockStatusLine(res blockReplayResult) string {
	if res.statusChanged == 0 && res.logsChanged == 0 {
		parts := []string{
			fmt.Sprintf("🟢 block %d", res.blockNum),
			"status okay, logs okay",
			fmt.Sprintf("tx=%d compared=%d skipped=%d", res.txTotal, res.compared, res.skippedUnsupported),
		}
		if res.gasMismatches == 0 {
			parts = append(parts, "gas okay")
		} else {
			parts = append(parts, fmt.Sprintf("gas repriced (mismatch=%d avgΔ=%.2f avg+Δ=%.2f)", res.gasMismatches, avgInt64(res.gasDeltaSum, res.compared), avgInt64(res.gasIncreaseSum, res.gasIncreaseCount)))
		}
		if res.blockGasLimitAtTx >= 0 {
			parts = append(parts, fmt.Sprintf("block gas limit reached at tx=%d (remaining=%d)", res.blockGasLimitAtTx, res.blockedTxs))
		}
		parts = append(parts, fmt.Sprintf("rpc=%d", res.rpcCalls), res.elapsed.Round(time.Millisecond).String())
		return strings.Join(parts, " | ")
	}

	parts := []string{
		fmt.Sprintf("%s block %d", blockHealthEmoji(res), res.blockNum),
		fmt.Sprintf("tx=%d compared=%d skipped=%d", res.txTotal, res.compared, res.skippedUnsupported),
	}

	if res.statusChanged == 0 {
		parts = append(parts, "status okay")
	} else {
		parts = append(parts, fmt.Sprintf("status Δ=%d (✅→❌ %d, ❌→✅ %d)", res.statusChanged, res.successToRevert, res.revertToSuccess))
	}

	if res.logsChanged == 0 {
		parts = append(parts, "logs okay")
	} else {
		parts = append(parts, fmt.Sprintf("logs Δ=%d", res.logsChanged))
	}

	if res.gasMismatches == 0 {
		parts = append(parts, "gas okay")
	} else {
		parts = append(parts, fmt.Sprintf("gas repriced (mismatch=%d avgΔ=%.2f avg+Δ=%.2f)", res.gasMismatches, avgInt64(res.gasDeltaSum, res.compared), avgInt64(res.gasIncreaseSum, res.gasIncreaseCount)))
	}
	if res.blockGasLimitAtTx >= 0 {
		parts = append(parts, fmt.Sprintf("block gas limit reached at tx=%d (remaining=%d)", res.blockGasLimitAtTx, res.blockedTxs))
	}

	parts = append(parts, fmt.Sprintf("rpc=%d", res.rpcCalls))
	parts = append(parts, res.elapsed.Round(time.Millisecond).String())
	return strings.Join(parts, " | ")
}

func fatalf(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "FATAL: "+format+"\n", args...)
	os.Exit(1)
}
