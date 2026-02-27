package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"math"
	"math/big"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	corethparams "github.com/ava-labs/avalanchego/graft/coreth/params"
	corethextras "github.com/ava-labs/avalanchego/graft/coreth/params/extras"
	corethcustomtypes "github.com/ava-labs/avalanchego/graft/coreth/plugin/evm/customtypes"
	warpcontract "github.com/ava-labs/avalanchego/graft/coreth/precompile/contracts/warp"
	_ "github.com/ava-labs/avalanchego/graft/coreth/precompile/registry"
	"github.com/ava-labs/avalanchego/snow"
	"github.com/ava-labs/libevm/common"
	"github.com/ava-labs/libevm/core"
	"github.com/ava-labs/libevm/core/types"
	"github.com/ava-labs/libevm/core/vm"
	"github.com/ava-labs/libevm/params"
	"github.com/holiman/uint256"
)

const replayBlockWorkers = 8

var (
	flagBlock            = flag.Uint64("block", 0, "single block to replay")
	flagFrom             = flag.Uint64("from", 0, "block range start")
	flagTo               = flag.Uint64("to", 0, "block range end (inclusive)")
	flagCacheDir         = flag.String("cache", "cache/blocks", "unused (cache disabled)")
	flagVerbose          = flag.Bool("v", false, "verbose output")
	flagProfile          = flag.String("profile", "baseline", "profile name for output labeling")
	flagSStoreSetMult    = flag.Float64("sstore-set-mult", 1.0, "multiplier for SSTORE clean zero->non-zero cost")
	flagCreate2Mult      = flag.Float64("create2-mult", 1.0, "multiplier for CREATE2 base cost")
	flagSkipUnsupported  = flag.Bool("skip-unsupported-precompiles", true, "exclude unsupported Avalanche precompile txs from mismatch stats")
	flagTraceUnsupported = flag.Bool("trace-unsupported-precompiles", false, "use debug_traceTransaction to detect internal system-precompile calls (accurate but much slower)")
	flagDebug            = flag.Bool("debug", false, "debug mode")
)

type ReplayTxResult struct {
	BlockNumber      uint64 `json:"block_number"`
	TxIndex          int    `json:"tx_index"`
	TxHash           string `json:"tx_hash"`
	Contract         string `json:"contract"`
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
}

type replayRunConfig struct {
	chainCfg         *params.ChainConfig
	chainID          *big.Int
	profile          string
	verbose          bool
	skipUnsupported  bool
	traceUnsupported bool
	baselineMode     bool
	cacheDir         string
}

type contractStats struct {
	total         int
	unchanged     int
	statusChanged int
	logsChanged   int
	precompileTxs int
}

// C-Chain mainnet config (all forks active for blocks > 3.3M).
func cchainConfig() *params.ChainConfig {
	cfg := &params.ChainConfig{
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
	return corethparams.WithExtra(cfg, &corethextras.ChainConfig{
		AvalancheContext: corethextras.AvalancheContext{
			SnowCtx: &snow.Context{NetworkID: 1},
		},
		NetworkUpgrades: corethextras.NetworkUpgrades{
			ApricotPhase1BlockTimestamp:     ptrU64(0),
			ApricotPhase2BlockTimestamp:     ptrU64(0),
			ApricotPhase3BlockTimestamp:     ptrU64(0),
			ApricotPhase4BlockTimestamp:     ptrU64(0),
			ApricotPhase5BlockTimestamp:     ptrU64(0),
			ApricotPhasePre6BlockTimestamp:  ptrU64(0),
			ApricotPhase6BlockTimestamp:     ptrU64(0),
			ApricotPhasePost6BlockTimestamp: ptrU64(0),
			BanffBlockTimestamp:             ptrU64(0),
			CortinaBlockTimestamp:           ptrU64(0),
			DurangoBlockTimestamp:           ptrU64(0),
			EtnaTimestamp:                   ptrU64(0),
			FortunaTimestamp:                ptrU64(0),
			GraniteTimestamp:                ptrU64(0),
			HeliconTimestamp:                ptrU64(0),
		},
		UpgradeConfig: corethextras.UpgradeConfig{
			PrecompileUpgrades: []corethextras.PrecompileUpgrade{{
				Config: warpcontract.NewDefaultConfig(ptrU64(0)),
			}},
		},
	})
}

func main() {
	flag.Parse()
	corethcustomtypes.Register()
	corethparams.RegisterExtras()

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

	chainCfg := cchainConfig()
	cfg := replayRunConfig{
		chainCfg:         chainCfg,
		chainID:          chainCfg.ChainID,
		profile:          *flagProfile,
		verbose:          *flagVerbose,
		skipUnsupported:  *flagSkipUnsupported,
		traceUnsupported: *flagSkipUnsupported && *flagTraceUnsupported,
		baselineMode:     *flagSStoreSetMult == 1.0 && *flagCreate2Mult == 1.0,
		cacheDir:         *flagCacheDir,
	}

	startAll := time.Now()
	resultsCh := replayBlocksParallel(from, to, cfg)
	totalBlocks := int(to-from) + 1
	nextPrintBlock := from
	pending := make(map[uint64]blockReplayResult, totalBlocks)
	doneBlocks := 0
	nextRefreshAt := time.Now()
	lastRenderedCompared := -1
	lastRenderedStatus := -1
	lastRenderedLogs := -1
	lastRenderedDoneBlocks := -1

	var totalCompared int
	var totalStatusChanged int
	var totalLogsChanged int
	var totalPrecompileTxs int
	byContract := make(map[string]*contractStats)

	for res := range resultsCh {
		pending[res.blockNum] = res

		for {
			orderedRes, ok := pending[nextPrintBlock]
			if !ok {
				break
			}
			delete(pending, nextPrintBlock)
			if orderedRes.err != nil {
				fatalf("block %d error: %v", nextPrintBlock, orderedRes.err)
			}

			totalCompared += orderedRes.compared
			totalStatusChanged += orderedRes.statusChanged
			totalLogsChanged += orderedRes.logsChanged
			totalPrecompileTxs += orderedRes.skippedUnsupported

			aggregateContractStats(byContract, orderedRes.rows)
			doneBlocks++
			if time.Now().After(nextRefreshAt) {
				renderDashboard(
					totalCompared,
					totalStatusChanged,
					totalLogsChanged,
					totalPrecompileTxs,
					from,
					to,
					doneBlocks,
					totalBlocks,
					*flagSStoreSetMult,
					*flagCreate2Mult,
					sstoreSetGas,
					create2Gas,
					byContract,
					time.Since(startAll),
				)
				lastRenderedCompared = totalCompared
				lastRenderedStatus = totalStatusChanged
				lastRenderedLogs = totalLogsChanged
				lastRenderedDoneBlocks = doneBlocks
				nextRefreshAt = time.Now().Add(1 * time.Second)
			}
			nextPrintBlock++
		}
	}
	if nextPrintBlock != to+1 {
		fatalf("missing block results; next=%d expected_end=%d", nextPrintBlock, to)
	}

	if totalCompared != lastRenderedCompared || totalStatusChanged != lastRenderedStatus || totalLogsChanged != lastRenderedLogs || doneBlocks != lastRenderedDoneBlocks {
		renderDashboard(
			totalCompared,
			totalStatusChanged,
			totalLogsChanged,
			totalPrecompileTxs,
			from,
			to,
			doneBlocks,
			totalBlocks,
			*flagSStoreSetMult,
			*flagCreate2Mult,
			sstoreSetGas,
			create2Gas,
			byContract,
			time.Since(startAll),
		)
	}
	fmt.Fprintln(os.Stderr)
}

func replayBlocksParallel(from uint64, to uint64, cfg replayRunConfig) <-chan blockReplayResult {
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

	return results
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
		Header: &types.Header{
			Number: new(big.Int).Set(header.Number),
			Time:   header.Time,
			Extra:  header.Extra,
		},
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
				appendNotExecutedRows(&res, txs, canonReceipts, i, blockNum, parentBlock, cfg)
				break
			}
			fatalf("block %d tx %d (%s) apply error: %v", blockNum, i, tx.Hash().Hex(), err)
		}

		// Avalanche C-Chain post-AP1 behavior: effective gas refunds are disabled.
		// libevm TransitionDb applies upstream refund mechanics, so we reverse that
		// accounting here to match canonical C-Chain receipt gas semantics.
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
		if !unsupportedTx && cfg.traceUnsupported {
			touches, traceErr := rpc.TraceTouchesSystemPrecompile(tx.Hash().Hex())
			if traceErr != nil {
				fatalf("block %d tx %d (%s) trace error: %v", blockNum, i, tx.Hash().Hex(), traceErr)
			}
			unsupportedTx = touches
		}

		replayLogs := state.GetLogs()
		logsChanged, logsDiffReason, logsCompareErr := compareReceiptLogs(canon.Logs, replayLogs)

		if cfg.skipUnsupported && cfg.baselineMode && !cfg.traceUnsupported && !unsupportedTx && (statusChanged || logsChanged || gasMismatch) {
			touches, traceErr := rpc.TraceTouchesSystemPrecompile(tx.Hash().Hex())
			if traceErr != nil {
				fatalf("block %d tx %d (%s) lazy trace error: %v", blockNum, i, tx.Hash().Hex(), traceErr)
			}
			if touches {
				unsupportedTx = true
			}
		}
		skippedCompare := cfg.skipUnsupported && unsupportedTx

		row := ReplayTxResult{
			BlockNumber:      blockNum,
			TxIndex:          i,
			TxHash:           tx.Hash().Hex(),
			Contract:         txDestination(tx),
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
		if logsChanged && !statusChanged {
			res.logsChanged++
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
			Contract:         txDestination(tx),
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
		if row.LogsChanged && !row.StatusChanged {
			res.logsChanged++
		}
	}
}

func txDestination(tx *types.Transaction) string {
	if to := tx.To(); to != nil {
		return strings.ToLower(to.Hex())
	}
	return "<create>"
}

func aggregateContractStats(byContract map[string]*contractStats, rows []ReplayTxResult) {
	for _, row := range rows {
		s, ok := byContract[row.Contract]
		if !ok {
			s = &contractStats{}
			byContract[row.Contract] = s
		}
		s.total++
		if row.UnsupportedTx {
			s.precompileTxs++
		}
		if row.SkippedCompare {
			continue
		}
		switch {
		case row.StatusChanged:
			s.statusChanged++
		case row.LogsChanged:
			s.logsChanged++
		default:
			s.unchanged++
		}
	}
}

func renderDashboard(
	analyzed int,
	statusChanged int,
	logsChanged int,
	precompileTxs int,
	from uint64,
	to uint64,
	doneBlocks int,
	totalBlocks int,
	sstoreMult float64,
	create2Mult float64,
	sstoreSetGas uint64,
	create2Gas uint64,
	byContract map[string]*contractStats,
	elapsed time.Duration,
) {
	type row struct {
		contract           string
		total              int
		statusChanged      int
		logsChanged        int
		affected           int
		ignoredPrecompiles int
		statusPct          float64
		logsPct            float64
		affectedPct        float64
	}

	rows := make([]row, 0, len(byContract))
	for contract, st := range byContract {
		if st.total == 0 {
			continue
		}
		affected := st.statusChanged + st.logsChanged
		if affected == 0 {
			continue
		}
		rows = append(rows, row{
			contract:           contract,
			total:              st.total,
			statusChanged:      st.statusChanged,
			logsChanged:        st.logsChanged,
			affected:           affected,
			ignoredPrecompiles: st.precompileTxs,
			statusPct:          pct(st.statusChanged, st.total),
			logsPct:            (float64(st.logsChanged) * 100.0) / float64(st.total),
			affectedPct:        pct(affected, st.total),
		})
	}

	sort.Slice(rows, func(i, j int) bool {
		if rows[i].affected != rows[j].affected {
			return rows[i].affected > rows[j].affected
		}
		if rows[i].statusChanged != rows[j].statusChanged {
			return rows[i].statusChanged > rows[j].statusChanged
		}
		if rows[i].logsChanged != rows[j].logsChanged {
			return rows[i].logsChanged > rows[j].logsChanged
		}
		if rows[i].total != rows[j].total {
			return rows[i].total > rows[j].total
		}
		return rows[i].contract < rows[j].contract
	})

	if len(rows) > 20 {
		rows = rows[:20]
	}

	affected := statusChanged + logsChanged
	lastBlock := "<none>"
	if doneBlocks > 0 {
		lastBlock = fmt.Sprintf("%d", from+uint64(doneBlocks)-1)
	}
	blockRate := 0.0
	if elapsed > 0 {
		blockRate = float64(doneBlocks) / elapsed.Seconds()
	}
	eta := "n/a"
	if blockRate > 0 {
		remaining := totalBlocks - doneBlocks
		if remaining < 0 {
			remaining = 0
		}
		etaDur := time.Duration(float64(remaining) / blockRate * float64(time.Second)).Round(time.Second)
		eta = etaDur.String()
	}
	fmt.Fprintln(os.Stderr, "Repricing Impact (live)")
	fmt.Fprintln(os.Stderr, "Repricing config:")
	fmt.Fprintf(
		os.Stderr,
		"  SSTORE (EIP-2200 clean 0->nonzero): old=%d new=%d mult=%.4f\n",
		params.SstoreSetGasEIP2200,
		sstoreSetGas,
		sstoreMult,
	)
	fmt.Fprintf(
		os.Stderr,
		"  CREATE2 (base): old=%d new=%d mult=%.4f\n",
		params.Create2Gas,
		create2Gas,
		create2Mult,
	)
	fmt.Fprintf(os.Stderr, "Block range: %d -> %d\n", from, to)
	fmt.Fprintf(os.Stderr, "Progress: %d/%d (%.2f%%) | Last block: %s\n", doneBlocks, totalBlocks, pct(doneBlocks, totalBlocks), lastBlock)
	fmt.Fprintf(os.Stderr, "Block rate: %.2f blk/s | ETA: %s\n", blockRate, eta)
	fmt.Fprintf(os.Stderr, "Elapsed: %s\n", elapsed.Round(time.Second))
	fmt.Fprintf(os.Stderr, "Transactions analyzed: %d\n", analyzed)
	fmt.Fprintf(os.Stderr, "Transactions changed status: %d (%.2f%%)\n", statusChanged, pct(statusChanged, analyzed))
	fmt.Fprintf(os.Stderr, "Transactions changed logs: %d (%.2f%%)\n", logsChanged, pct(logsChanged, analyzed))
	fmt.Fprintf(os.Stderr, "Transactions affected total: %d (%.2f%%)\n", affected, pct(affected, analyzed))
	fmt.Fprintf(os.Stderr, "Ignored (precompiles): %d\n", precompileTxs)
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "All contracts total")
	fmt.Fprintln(os.Stderr, "contract                                    analyzed   ignored  statusΔ  logsΔ  affected  status%  logs%  affected%")
	fmt.Fprintf(
		os.Stderr,
		"%-42s %9d %8d %8d %7d %10d %8.2f %6.2f %9.2f\n",
		"TOTAL",
		analyzed,
		precompileTxs,
		statusChanged,
		logsChanged,
		affected,
		pct(statusChanged, analyzed),
		pct(logsChanged, analyzed),
		pct(affected, analyzed),
	)
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "Top 20 contracts by affected txs (absolute count, statusΔ + logsΔ)")
	fmt.Fprintln(os.Stderr, "contract                                    analyzed   ignored  statusΔ  logsΔ  affected  status%  logs%  affected%")
	if len(rows) == 0 {
		fmt.Fprintln(os.Stderr, "(no affected contracts yet)")
	}
	for _, r := range rows {
		fmt.Fprintf(
			os.Stderr,
			"%-42s %9d %8d %8d %7d %10d %8.2f %6.2f %9.2f\n",
			r.contract,
			r.total,
			r.ignoredPrecompiles,
			r.statusChanged,
			r.logsChanged,
			r.affected,
			r.statusPct,
			r.logsPct,
			r.affectedPct,
		)
	}
}

func pct(v int, total int) float64 {
	if total == 0 {
		return 0
	}
	return (float64(v) * 100.0) / float64(total)
}

func fatalf(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "FATAL: "+format+"\n", args...)
	os.Exit(1)
}
