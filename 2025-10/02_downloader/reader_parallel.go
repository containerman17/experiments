package main

import (
	"bufio"
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/bytedance/sonic"
)

type ArchivedBlock struct {
	Block    BlockData `json:"block"`
	Traces   []Trace   `json:"traces"`
	Receipts []Receipt `json:"receipts"`
}

type BlockData struct {
	BaseFeePerGas    string        `json:"baseFeePerGas"`
	BlockGasCost     string        `json:"blockGasCost"`
	Difficulty       string        `json:"difficulty"`
	ExtraData        string        `json:"extraData"`
	GasLimit         string        `json:"gasLimit"`
	GasUsed          string        `json:"gasUsed"`
	Hash             string        `json:"hash"`
	LogsBloom        string        `json:"logsBloom"`
	Miner            string        `json:"miner"`
	MixHash          string        `json:"mixHash"`
	Nonce            string        `json:"nonce"`
	Number           string        `json:"number"`
	ParentHash       string        `json:"parentHash"`
	ReceiptsRoot     string        `json:"receiptsRoot"`
	Sha3Uncles       string        `json:"sha3Uncles"`
	Size             string        `json:"size"`
	StateRoot        string        `json:"stateRoot"`
	Timestamp        string        `json:"timestamp"`
	TotalDifficulty  string        `json:"totalDifficulty"`
	Transactions     []Transaction `json:"transactions"`
	TransactionsRoot string        `json:"transactionsRoot"`
	Uncles           []string      `json:"uncles"`
}

type Transaction struct {
	BlockHash        string `json:"blockHash"`
	BlockNumber      string `json:"blockNumber"`
	From             string `json:"from"`
	Gas              string `json:"gas"`
	GasPrice         string `json:"gasPrice"`
	Hash             string `json:"hash"`
	Input            string `json:"input"`
	Nonce            int64  `json:"nonce"`
	To               string `json:"to"`
	TransactionIndex int    `json:"transactionIndex"`
	Value            string `json:"value"`
	Type             string `json:"type"`
	ChainId          int    `json:"chainId"`
	V                string `json:"v"`
	R                string `json:"r"`
	S                string `json:"s"`
	TypeHex          string `json:"typeHex"`
}

type Trace struct {
	TxHash string      `json:"txHash"`
	Result TraceResult `json:"result"`
}

type TraceResult struct {
	From    string         `json:"from"`
	Gas     string         `json:"gas"`
	GasUsed string         `json:"gasUsed"`
	To      string         `json:"to"`
	Input   string         `json:"input"`
	Output  string         `json:"output"`
	Value   string         `json:"value"`
	Type    string         `json:"type"`
	Calls   []*TraceResult `json:"calls,omitempty"`
}

type Receipt struct {
	BlockHash         string      `json:"blockHash"`
	BlockNumber       string      `json:"blockNumber"`
	ContractAddress   interface{} `json:"contractAddress"`
	CumulativeGasUsed string      `json:"cumulativeGasUsed"`
	EffectiveGasPrice string      `json:"effectiveGasPrice"`
	From              string      `json:"from"`
	GasUsed           string      `json:"gasUsed"`
	Logs              []Log       `json:"logs"`
	LogsBloom         string      `json:"logsBloom"`
	Status            string      `json:"status"`
	To                string      `json:"to"`
	TransactionHash   string      `json:"transactionHash"`
	TransactionIndex  int         `json:"transactionIndex"`
	Type              string      `json:"type"`
}

type Log struct {
	Address          string   `json:"address"`
	Topics           []string `json:"topics"`
	Data             string   `json:"data"`
	BlockNumber      string   `json:"blockNumber"`
	TransactionHash  string   `json:"transactionHash"`
	TransactionIndex int      `json:"transactionIndex"`
	BlockHash        string   `json:"blockHash"`
	LogIndex         int      `json:"logIndex"`
	Removed          bool     `json:"removed"`
}

type FileInfo struct {
	name  string
	start int
	end   int
}

type RawLine struct {
	data       string
	fileIndex  int
	lineInFile int
}

type LogRow struct {
	BlockTime       int64
	BlockNumber     string
	BlockHash       string
	ContractAddress string
	Topic0          string
	Topic1          string
	Topic2          string
	Topic3          string
	Data            string
	TxHash          string
	LogIndex        int
	TxIndex         int
	BlockDate       string
	TxFrom          string
	TxTo            string
}

type TraceRow struct {
	BlockTime     int64
	BlockNumber   string
	Value         string
	Gas           string
	GasUsed       string
	BlockHash     string
	Success       uint8
	TxIndex       int
	SubTraces     string
	Error         string
	TxSuccess     uint8
	TxHash        string
	TraceFrom     string
	TraceTo       string
	TraceAddress  []uint64
	TraceType     string
	Address       string
	Code          string
	CallType      string
	Input         string
	Output        string
	RefundAddress string
	BlockDate     string
}

type ClickHouseBuffer struct {
	conn        driver.Conn
	logsBuf     []LogRow
	tracesBuf   []TraceRow
	txCount     int
	mu          sync.Mutex
	flushTicker *time.Ticker
	stopChan    chan struct{}
}

func newClickHouseBuffer() (*ClickHouseBuffer, error) {
	conn, err := clickhouse.Open(&clickhouse.Options{
		Addr: []string{"localhost:9000"},
		Auth: clickhouse.Auth{
			Database: "default",
			Username: "default",
			Password: "nopassword",
		},
	})
	if err != nil {
		return nil, err
	}

	// Create tables
	ctx := context.Background()
	if err := conn.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS logs (
			block_time DateTime,
			block_number UInt64,
			block_hash String,
			contract_address String,
			topic0 String,
			topic1 String,
			topic2 String,
			topic3 String,
			data String,
			tx_hash String,
			log_index UInt32,
			tx_index UInt32,
			block_date Date,
			tx_from String,
			tx_to String
		) ENGINE = MergeTree()
		PARTITION BY toYYYYMM(block_time)
		ORDER BY (block_number, tx_index, log_index)
	`); err != nil {
		return nil, err
	}

	if err := conn.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS traces (
			block_time DateTime,
			block_number UInt64,
			value String,
			gas UInt64,
			gas_used UInt64,
			block_hash String,
			success UInt8,
			tx_index UInt32,
			sub_traces UInt64,
			error String,
			tx_success UInt8,
			tx_hash String,
			trace_from String,
			trace_to String,
			trace_address Array(UInt64),
			trace_type String,
			address String,
			code String,
			call_type String,
			input String,
			output String,
			refund_address String,
			block_date Date
		) ENGINE = MergeTree()
		PARTITION BY toYYYYMM(block_time)
		ORDER BY (block_number, tx_index, trace_address)
	`); err != nil {
		return nil, err
	}

	fmt.Println("ClickHouse tables created")

	buf := &ClickHouseBuffer{
		conn:        conn,
		logsBuf:     make([]LogRow, 0, 100000),
		tracesBuf:   make([]TraceRow, 0, 100000),
		flushTicker: time.NewTicker(2 * time.Second),
		stopChan:    make(chan struct{}),
	}

	go buf.autoFlush()

	return buf, nil
}

func (b *ClickHouseBuffer) autoFlush() {
	for {
		select {
		case <-b.flushTicker.C:
			if err := b.flush(); err != nil {
				log.Printf("Error flushing buffer: %v", err)
			}
		case <-b.stopChan:
			return
		}
	}
}

func (b *ClickHouseBuffer) addBlock(block *ArchivedBlock) {
	b.mu.Lock()
	defer b.mu.Unlock()

	timestamp, _ := strconv.ParseInt(block.Block.Timestamp, 10, 64)
	blockNumber := block.Block.Number
	blockHash := block.Block.Hash
	blockDate := time.Unix(timestamp, 0).Format("2006-01-02")

	b.txCount += len(block.Block.Transactions)

	// Process logs
	for _, receipt := range block.Receipts {
		for logIdx, logEntry := range receipt.Logs {
			topic0, topic1, topic2, topic3 := "", "", "", ""
			if len(logEntry.Topics) > 0 {
				topic0 = logEntry.Topics[0]
			}
			if len(logEntry.Topics) > 1 {
				topic1 = logEntry.Topics[1]
			}
			if len(logEntry.Topics) > 2 {
				topic2 = logEntry.Topics[2]
			}
			if len(logEntry.Topics) > 3 {
				topic3 = logEntry.Topics[3]
			}

			b.logsBuf = append(b.logsBuf, LogRow{
				BlockTime:       timestamp,
				BlockNumber:     blockNumber,
				BlockHash:       blockHash,
				ContractAddress: logEntry.Address,
				Topic0:          topic0,
				Topic1:          topic1,
				Topic2:          topic2,
				Topic3:          topic3,
				Data:            logEntry.Data,
				TxHash:          receipt.TransactionHash,
				LogIndex:        logIdx,
				TxIndex:         receipt.TransactionIndex,
				BlockDate:       blockDate,
				TxFrom:          receipt.From,
				TxTo:            receipt.To,
			})
		}
	}

	// Process traces
	for txIdx, trace := range block.Traces {
		var txSuccess uint8
		if len(block.Receipts) > txIdx && block.Receipts[txIdx].Status == "0x1" {
			txSuccess = 1
		}
		b.flattenTrace(&trace.Result, []uint64{}, timestamp, blockNumber, blockHash, blockDate, trace.TxHash, txIdx, txSuccess)
	}
}

func (b *ClickHouseBuffer) flattenTrace(trace *TraceResult, traceAddress []uint64, blockTime int64, blockNumber, blockHash, blockDate, txHash string, txIndex int, txSuccess uint8) {
	if trace == nil {
		return
	}

	success := uint8(1)
	if trace.Type == "" {
		success = 0
	}

	subTraces := len(trace.Calls)

	// Convert hex to decimal for gas values
	parseHex := func(val string) string {
		if val == "" {
			return "0"
		}
		if strings.HasPrefix(val, "0x") {
			if num, err := strconv.ParseUint(val, 0, 64); err == nil {
				return strconv.FormatUint(num, 10)
			}
		}
		return val
	}

	b.tracesBuf = append(b.tracesBuf, TraceRow{
		BlockTime:     blockTime,
		BlockNumber:   blockNumber,
		Value:         parseHex(trace.Value),
		Gas:           parseHex(trace.Gas),
		GasUsed:       parseHex(trace.GasUsed),
		BlockHash:     blockHash,
		Success:       success,
		TxIndex:       txIndex,
		SubTraces:     strconv.Itoa(subTraces),
		Error:         "",
		TxSuccess:     txSuccess,
		TxHash:        txHash,
		TraceFrom:     trace.From,
		TraceTo:       trace.To,
		TraceAddress:  append([]uint64{}, traceAddress...),
		TraceType:     trace.Type,
		Address:       "",
		Code:          "",
		CallType:      "",
		Input:         trace.Input,
		Output:        trace.Output,
		RefundAddress: "",
		BlockDate:     blockDate,
	})

	for i, call := range trace.Calls {
		newAddr := append(traceAddress, uint64(i))
		b.flattenTrace(call, newAddr, blockTime, blockNumber, blockHash, blockDate, txHash, txIndex, txSuccess)
	}
}

func (b *ClickHouseBuffer) flush() error {
	b.mu.Lock()
	logsToFlush := b.logsBuf
	tracesToFlush := b.tracesBuf
	txsToFlush := b.txCount

	b.logsBuf = make([]LogRow, 0, 100000)
	b.tracesBuf = make([]TraceRow, 0, 100000)
	b.txCount = 0
	b.mu.Unlock()

	if len(logsToFlush) == 0 && len(tracesToFlush) == 0 {
		return nil
	}

	start := time.Now()
	ctx := context.Background()

	if len(logsToFlush) > 0 {
		// Prepare columnar data for Native format
		blockTimes := make([]time.Time, len(logsToFlush))
		blockNums := make([]uint64, len(logsToFlush))
		blockHashes := make([]string, len(logsToFlush))
		contractAddrs := make([]string, len(logsToFlush))
		topic0s := make([]string, len(logsToFlush))
		topic1s := make([]string, len(logsToFlush))
		topic2s := make([]string, len(logsToFlush))
		topic3s := make([]string, len(logsToFlush))
		datas := make([]string, len(logsToFlush))
		txHashes := make([]string, len(logsToFlush))
		logIndexes := make([]uint32, len(logsToFlush))
		txIndexes := make([]uint32, len(logsToFlush))
		blockDates := make([]string, len(logsToFlush))
		txFroms := make([]string, len(logsToFlush))
		txTos := make([]string, len(logsToFlush))

		for i, row := range logsToFlush {
			blockTimes[i] = time.Unix(row.BlockTime, 0)
			blockNums[i], _ = strconv.ParseUint(row.BlockNumber, 10, 64)
			blockHashes[i] = row.BlockHash
			contractAddrs[i] = row.ContractAddress
			topic0s[i] = row.Topic0
			topic1s[i] = row.Topic1
			topic2s[i] = row.Topic2
			topic3s[i] = row.Topic3
			datas[i] = row.Data
			txHashes[i] = row.TxHash
			logIndexes[i] = uint32(row.LogIndex)
			txIndexes[i] = uint32(row.TxIndex)
			blockDates[i] = row.BlockDate
			txFroms[i] = row.TxFrom
			txTos[i] = row.TxTo
		}

		batch, err := b.conn.PrepareBatch(ctx, "INSERT INTO logs")
		if err != nil {
			return err
		}

		if err := batch.Column(0).Append(blockTimes); err != nil {
			return err
		}
		if err := batch.Column(1).Append(blockNums); err != nil {
			return err
		}
		if err := batch.Column(2).Append(blockHashes); err != nil {
			return err
		}
		if err := batch.Column(3).Append(contractAddrs); err != nil {
			return err
		}
		if err := batch.Column(4).Append(topic0s); err != nil {
			return err
		}
		if err := batch.Column(5).Append(topic1s); err != nil {
			return err
		}
		if err := batch.Column(6).Append(topic2s); err != nil {
			return err
		}
		if err := batch.Column(7).Append(topic3s); err != nil {
			return err
		}
		if err := batch.Column(8).Append(datas); err != nil {
			return err
		}
		if err := batch.Column(9).Append(txHashes); err != nil {
			return err
		}
		if err := batch.Column(10).Append(logIndexes); err != nil {
			return err
		}
		if err := batch.Column(11).Append(txIndexes); err != nil {
			return err
		}
		if err := batch.Column(12).Append(blockDates); err != nil {
			return err
		}
		if err := batch.Column(13).Append(txFroms); err != nil {
			return err
		}
		if err := batch.Column(14).Append(txTos); err != nil {
			return err
		}

		if err := batch.Send(); err != nil {
			return err
		}
	}

	if len(tracesToFlush) > 0 {
		// Prepare columnar data for Native format
		blockTimes := make([]time.Time, len(tracesToFlush))
		blockNums := make([]uint64, len(tracesToFlush))
		values := make([]string, len(tracesToFlush))
		gases := make([]uint64, len(tracesToFlush))
		gasUseds := make([]uint64, len(tracesToFlush))
		blockHashes := make([]string, len(tracesToFlush))
		successes := make([]uint8, len(tracesToFlush))
		txIndexes := make([]uint32, len(tracesToFlush))
		subTraces := make([]uint64, len(tracesToFlush))
		errors := make([]string, len(tracesToFlush))
		txSuccesses := make([]uint8, len(tracesToFlush))
		txHashes := make([]string, len(tracesToFlush))
		traceFroms := make([]string, len(tracesToFlush))
		traceTos := make([]string, len(tracesToFlush))
		traceAddrs := make([][]uint64, len(tracesToFlush))
		traceTypes := make([]string, len(tracesToFlush))
		addresses := make([]string, len(tracesToFlush))
		codes := make([]string, len(tracesToFlush))
		callTypes := make([]string, len(tracesToFlush))
		inputs := make([]string, len(tracesToFlush))
		outputs := make([]string, len(tracesToFlush))
		refundAddrs := make([]string, len(tracesToFlush))
		blockDates := make([]string, len(tracesToFlush))

		for i, row := range tracesToFlush {
			blockTimes[i] = time.Unix(row.BlockTime, 0)
			blockNums[i], _ = strconv.ParseUint(row.BlockNumber, 10, 64)
			values[i] = row.Value
			gases[i], _ = strconv.ParseUint(row.Gas, 10, 64)
			gasUseds[i], _ = strconv.ParseUint(row.GasUsed, 10, 64)
			blockHashes[i] = row.BlockHash
			successes[i] = row.Success
			txIndexes[i] = uint32(row.TxIndex)
			subTraces[i], _ = strconv.ParseUint(row.SubTraces, 10, 64)
			errors[i] = row.Error
			txSuccesses[i] = row.TxSuccess
			txHashes[i] = row.TxHash
			traceFroms[i] = row.TraceFrom
			traceTos[i] = row.TraceTo
			traceAddrs[i] = row.TraceAddress
			traceTypes[i] = row.TraceType
			addresses[i] = row.Address
			codes[i] = row.Code
			callTypes[i] = row.CallType
			inputs[i] = row.Input
			outputs[i] = row.Output
			refundAddrs[i] = row.RefundAddress
			blockDates[i] = row.BlockDate
		}

		batch, err := b.conn.PrepareBatch(ctx, "INSERT INTO traces")
		if err != nil {
			return err
		}

		if err := batch.Column(0).Append(blockTimes); err != nil {
			return err
		}
		if err := batch.Column(1).Append(blockNums); err != nil {
			return err
		}
		if err := batch.Column(2).Append(values); err != nil {
			return err
		}
		if err := batch.Column(3).Append(gases); err != nil {
			return err
		}
		if err := batch.Column(4).Append(gasUseds); err != nil {
			return err
		}
		if err := batch.Column(5).Append(blockHashes); err != nil {
			return err
		}
		if err := batch.Column(6).Append(successes); err != nil {
			return err
		}
		if err := batch.Column(7).Append(txIndexes); err != nil {
			return err
		}
		if err := batch.Column(8).Append(subTraces); err != nil {
			return err
		}
		if err := batch.Column(9).Append(errors); err != nil {
			return err
		}
		if err := batch.Column(10).Append(txSuccesses); err != nil {
			return err
		}
		if err := batch.Column(11).Append(txHashes); err != nil {
			return err
		}
		if err := batch.Column(12).Append(traceFroms); err != nil {
			return err
		}
		if err := batch.Column(13).Append(traceTos); err != nil {
			return err
		}
		if err := batch.Column(14).Append(traceAddrs); err != nil {
			return err
		}
		if err := batch.Column(15).Append(traceTypes); err != nil {
			return err
		}
		if err := batch.Column(16).Append(addresses); err != nil {
			return err
		}
		if err := batch.Column(17).Append(codes); err != nil {
			return err
		}
		if err := batch.Column(18).Append(callTypes); err != nil {
			return err
		}
		if err := batch.Column(19).Append(inputs); err != nil {
			return err
		}
		if err := batch.Column(20).Append(outputs); err != nil {
			return err
		}
		if err := batch.Column(21).Append(refundAddrs); err != nil {
			return err
		}
		if err := batch.Column(22).Append(blockDates); err != nil {
			return err
		}

		if err := batch.Send(); err != nil {
			return err
		}
	}

	ms := time.Since(start).Milliseconds()
	txsPerSecond := int64(0)
	if ms > 0 {
		txsPerSecond = (int64(txsToFlush) * 1000) / ms
	}

	fmt.Printf("Flushed %d logs, %d traces (%d txs) | %dms | %d tx/s\n",
		len(logsToFlush), len(tracesToFlush), txsToFlush, ms, txsPerSecond)

	return nil
}

func (b *ClickHouseBuffer) close() error {
	close(b.stopChan)
	b.flushTicker.Stop()
	if err := b.flush(); err != nil {
		return err
	}
	return b.conn.Close()
}

func main() {
	dir := filepath.Join("/data", "2q9e4r6Mu3U68nU1fYjgbR6JvwrRx36CohpAX5UQxse55x1Q5")

	chBuf, err := newClickHouseBuffer()
	if err != nil {
		log.Fatal(err)
	}
	defer chBuf.close()

	numParsers := runtime.NumCPU()
	fmt.Printf("Using %d CPU cores for JSON parsing\n", numParsers)

	var totalBlocks int64
	var totalTxs int64
	var lastBlock int64
	expectedBlock := int64(1)

	const totalTxsTarget = 760_000_000

	// Stats goroutine
	go func() {
		start := time.Now()
		lastTxCount := int64(0)
		ticker := time.NewTicker(1 * time.Second)
		defer ticker.Stop()

		for range ticker.C {
			currentTxs := atomic.LoadInt64(&totalTxs)
			currentBlocks := atomic.LoadInt64(&totalBlocks)
			currentLastBlock := atomic.LoadInt64(&lastBlock)

			percentage := float64(currentTxs) / float64(totalTxsTarget) * 100
			elapsedSeconds := time.Since(start).Seconds()
			intervalTxs := currentTxs - lastTxCount
			avgTxsPerSecond := float64(currentTxs) / elapsedSeconds
			blocksPerSecond := float64(currentBlocks) / elapsedSeconds

			timeLeft := "N/A"
			if avgTxsPerSecond > 0 {
				remainingTxs := totalTxsTarget - currentTxs
				secondsLeft := float64(remainingTxs) / avgTxsPerSecond
				hours := int(secondsLeft / 3600)
				minutes := int((int(secondsLeft) % 3600) / 60)
				seconds := int(secondsLeft) % 60
				timeLeft = fmt.Sprintf("%dh %dm %ds", hours, minutes, seconds)
			}

			fmt.Printf("Progress: %.4f%% (%d/%d). %d txs/s, %.2f blocks/s, avg: %.2f txs/s, time left: %s, last block: %d\n",
				percentage, currentTxs, totalTxsTarget, intervalTxs, blocksPerSecond, avgTxsPerSecond, timeLeft, currentLastBlock)

			lastTxCount = currentTxs
		}
	}()

	// Find all archives upfront
	archives := scanArchives(dir)

	// Process files with parallel parsing
	for _, archive := range archives {
		fmt.Printf("Processing: %s\n", archive.name)
		processFileParallel(filepath.Join(dir, archive.name), numParsers, &totalBlocks, &totalTxs, &lastBlock, &expectedBlock, chBuf)
	}

	fmt.Printf("✓ Validation passed: %d blocks in perfect sequence from 1 to %d\n", totalBlocks, lastBlock)
}

func processFileParallel(path string, numParsers int, totalBlocks, totalTxs, lastBlock, expectedBlock *int64, chBuf *ClickHouseBuffer) {
	// Decompress file to lines
	lineChan := make(chan string, 10000)

	go func() {
		defer close(lineChan)

		cmd := exec.Command("zstd", "-d", "-c", path)
		stdout, _ := cmd.StdoutPipe()
		cmd.Start()
		defer cmd.Process.Kill()

		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 0, 1024*1024), 10*1024*1024)

		for scanner.Scan() {
			line := scanner.Text()
			if len(line) > 0 {
				lineChan <- line
			}
		}

		cmd.Wait()
	}()

	// Parse in parallel
	blockChan := make(chan *ArchivedBlock, 10000)

	var wg sync.WaitGroup
	for i := 0; i < numParsers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for line := range lineChan {
				var block ArchivedBlock
				if err := sonic.UnmarshalString(line, &block); err != nil {
					log.Printf("Parse error: %v", err)
					continue
				}
				blockChan <- &block
			}
		}()
	}

	go func() {
		wg.Wait()
		close(blockChan)
	}()

	// Collect blocks from this file and sort
	var blocks []*ArchivedBlock
	for block := range blockChan {
		blocks = append(blocks, block)
	}

	// Sort by block number
	sort.Slice(blocks, func(i, j int) bool {
		ni, _ := strconv.ParseInt(blocks[i].Block.Number, 10, 64)
		nj, _ := strconv.ParseInt(blocks[j].Block.Number, 10, 64)
		return ni < nj
	})

	// Validate and count
	for _, block := range blocks {
		blockNum, _ := strconv.ParseInt(block.Block.Number, 10, 64)

		if blockNum != *expectedBlock {
			log.Fatalf("Block sequence error: expected %d, got %d", *expectedBlock, blockNum)
		}

		chBuf.addBlock(block)

		atomic.AddInt64(totalBlocks, 1)
		// Count transactions (this is what TypeScript counts)
		atomic.AddInt64(totalTxs, int64(len(block.Block.Transactions)))
		atomic.StoreInt64(lastBlock, blockNum)
		*expectedBlock = blockNum + 1
	}
}

func scanArchives(dir string) []FileInfo {
	entries, _ := os.ReadDir(dir)

	var archives []FileInfo
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".jsonl.zstd") {
			continue
		}

		parts := strings.Split(strings.TrimSuffix(name, ".jsonl.zstd"), "-")
		if len(parts) != 2 {
			continue
		}

		start, _ := strconv.Atoi(parts[0])
		end, _ := strconv.Atoi(parts[1])

		archives = append(archives, FileInfo{name, start, end})
	}

	sort.Slice(archives, func(i, j int) bool {
		return archives[i].start < archives[j].start
	})

	return archives
}
