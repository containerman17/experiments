package rpc

import (
	"encoding/json"
	"fmt"
	"math/big"
	"strings"

	"github.com/ava-labs/libevm/common"
	"github.com/ava-labs/libevm/common/hexutil"
	ethtypes "github.com/ava-labs/libevm/core/types"

	"block_fetcher/store"
)

// addrHex returns a lowercase hex address string (no EIP-55 checksum).
func addrHex(a common.Address) string {
	return strings.ToLower(a.Hex())
}

// formatBlock formats an eth block for JSON-RPC response.
func formatBlock(block *ethtypes.Block, fullTx bool) map[string]any {
	header := block.Header()
	result := map[string]any{
		"number":           fmt.Sprintf("0x%x", header.Number),
		"hash":             block.Hash().Hex(),
		"parentHash":       header.ParentHash.Hex(),
		"nonce":            fmt.Sprintf("0x%016x", header.Nonce),
		"sha3Uncles":       header.UncleHash.Hex(),
		"logsBloom":        hexutil.Encode(header.Bloom[:]),
		"transactionsRoot": header.TxHash.Hex(),
		"stateRoot":        header.Root.Hex(),
		"receiptsRoot":     header.ReceiptHash.Hex(),
		"miner":            addrHex(header.Coinbase),
		"difficulty":       encodeBigInt(header.Difficulty),
		"totalDifficulty":  "0x0",
		"extraData":        hexutil.Encode(header.Extra),
		"size":             fmt.Sprintf("0x%x", block.Size()),
		"gasLimit":         fmt.Sprintf("0x%x", header.GasLimit),
		"gasUsed":          fmt.Sprintf("0x%x", header.GasUsed),
		"timestamp":        fmt.Sprintf("0x%x", header.Time),
		"uncles":           []string{},
		"mixHash":          header.MixDigest.Hex(),
	}

	if header.BaseFee != nil {
		result["baseFeePerGas"] = encodeBigInt(header.BaseFee)
	}

	txs := block.Transactions()
	if fullTx {
		txList := make([]map[string]any, len(txs))
		for i, tx := range txs {
			txList[i] = formatTransaction(tx, block, i)
		}
		result["transactions"] = txList
	} else {
		txHashes := make([]string, len(txs))
		for i, tx := range txs {
			txHashes[i] = tx.Hash().Hex()
		}
		result["transactions"] = txHashes
	}

	return result
}

// formatTransaction formats a transaction for JSON-RPC response.
func formatTransaction(tx *ethtypes.Transaction, block *ethtypes.Block, index int) map[string]any {
	signer := ethtypes.LatestSignerForChainID(tx.ChainId())
	from, _ := ethtypes.Sender(signer, tx)
	v, r, s := tx.RawSignatureValues()

	result := map[string]any{
		"hash":             tx.Hash().Hex(),
		"nonce":            fmt.Sprintf("0x%x", tx.Nonce()),
		"blockHash":        block.Hash().Hex(),
		"blockNumber":      fmt.Sprintf("0x%x", block.NumberU64()),
		"transactionIndex": fmt.Sprintf("0x%x", index),
		"from":             addrHex(from),
		"value":            encodeBigInt(tx.Value()),
		"gas":              fmt.Sprintf("0x%x", tx.Gas()),
		"input":            hexutil.Encode(tx.Data()),
		"type":             fmt.Sprintf("0x%x", tx.Type()),
		"v":                encodeBigInt(v),
		"r":                encodeBigInt(r),
		"s":                encodeBigInt(s),
	}

	if tx.To() != nil {
		result["to"] = addrHex(*tx.To())
	} else {
		result["to"] = nil
	}

	if tx.GasPrice() != nil {
		result["gasPrice"] = encodeBigInt(tx.GasPrice())
	}

	return result
}

// formatLogFromReceipt formats a log entry from a receipt for JSON-RPC response.
func formatLogFromReceipt(l store.LogEntry, txIndex, logIndex uint16, blockNum uint64, blockHash common.Hash, txHash [32]byte) map[string]any {
	topics := make([]string, len(l.Topics))
	for i, t := range l.Topics {
		topics[i] = common.Hash(t).Hex()
	}

	return map[string]any{
		"address":          addrHex(common.Address(l.Address)),
		"topics":           topics,
		"data":             hexutil.Encode(l.Data),
		"blockNumber":      fmt.Sprintf("0x%x", blockNum),
		"blockHash":        blockHash.Hex(),
		"transactionHash":  common.Hash(txHash).Hex(),
		"transactionIndex": fmt.Sprintf("0x%x", txIndex),
		"logIndex":         fmt.Sprintf("0x%x", logIndex),
		"removed":          false,
	}
}

// formatReceipt formats a stored receipt for JSON-RPC response.
func formatReceipt(r store.TxReceipt, txIndex uint16, blockNum uint64, block *ethtypes.Block) map[string]any {
	// Build logs array with proper indexes.
	logs := make([]map[string]any, len(r.Logs))
	blockHash := block.Hash()
	logIdx := uint16(0)
	// Compute starting log index by counting logs in preceding txs.
	// For simplicity, we'd need all receipts. Approximate with 0 for now.
	// TODO: pass cumulative log index from caller if needed.
	for i, l := range r.Logs {
		logs[i] = formatLogFromReceipt(l, txIndex, logIdx, blockNum, blockHash, r.TxHash)
		logIdx++
	}

	result := map[string]any{
		"transactionHash":   common.Hash(r.TxHash).Hex(),
		"transactionIndex":  fmt.Sprintf("0x%x", txIndex),
		"blockHash":         blockHash.Hex(),
		"blockNumber":       fmt.Sprintf("0x%x", blockNum),
		"from":              "", // TODO: recover from tx
		"to":                nil,
		"cumulativeGasUsed": fmt.Sprintf("0x%x", r.CumulativeGas),
		"gasUsed":           fmt.Sprintf("0x%x", r.GasUsed),
		"contractAddress":   nil,
		"logs":              logs,
		"logsBloom":         "0x" + strings.Repeat("00", 256),
		"status":            fmt.Sprintf("0x%x", r.Status),
		"type":              fmt.Sprintf("0x%x", r.TxType),
	}

	// Fill from/to from block's transaction.
	txs := block.Transactions()
	if int(txIndex) < len(txs) {
		tx := txs[txIndex]
		signer := ethtypes.LatestSignerForChainID(tx.ChainId())
		from, _ := ethtypes.Sender(signer, tx)
		result["from"] = addrHex(from)
		if tx.To() != nil {
			result["to"] = addrHex(*tx.To())
		}
		result["effectiveGasPrice"] = encodeBigInt(tx.GasPrice())
	}

	var zeroAddr [20]byte
	if r.ContractAddress != zeroAddr {
		result["contractAddress"] = addrHex(common.Address(r.ContractAddress))
	}

	return result
}

func encodeBigInt(n *big.Int) string {
	if n == nil {
		return "0x0"
	}
	return fmt.Sprintf("0x%x", n)
}

// LogFilter represents the params for eth_getLogs.
type LogFilter struct {
	FromBlock string           `json:"fromBlock"`
	ToBlock   string           `json:"toBlock"`
	Address   json.RawMessage  `json:"address"`   // string or []string
	Topics    []json.RawMessage `json:"topics"`    // each: null, string, or []string
}

// matchesLog checks if a log matches the filter criteria.
func (f *LogFilter) matchesLog(l store.LogEntry) bool {
	// Check address filter.
	if len(f.Address) > 0 {
		addrs := f.parseAddresses()
		if len(addrs) > 0 {
			found := false
			for _, a := range addrs {
				if a == l.Address {
					found = true
					break
				}
			}
			if !found {
				return false
			}
		}
	}

	// Check topic filters.
	for i, topicFilter := range f.Topics {
		if len(topicFilter) == 0 || string(topicFilter) == "null" {
			continue
		}
		if i >= len(l.Topics) {
			return false
		}
		topicValues := parseTopicFilter(topicFilter)
		if len(topicValues) == 0 {
			continue
		}
		found := false
		for _, tv := range topicValues {
			if tv == l.Topics[i] {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}

	return true
}

func (f *LogFilter) parseAddresses() [][20]byte {
	// Try single address.
	var single string
	if err := json.Unmarshal(f.Address, &single); err == nil {
		addr := common.HexToAddress(single)
		return [][20]byte{[20]byte(addr)}
	}
	// Try array.
	var arr []string
	if err := json.Unmarshal(f.Address, &arr); err == nil {
		result := make([][20]byte, len(arr))
		for i, s := range arr {
			result[i] = [20]byte(common.HexToAddress(s))
		}
		return result
	}
	return nil
}

func parseTopicFilter(raw json.RawMessage) [][32]byte {
	// Try single topic.
	var single string
	if err := json.Unmarshal(raw, &single); err == nil {
		h := common.HexToHash(single)
		return [][32]byte{[32]byte(h)}
	}
	// Try array.
	var arr []string
	if err := json.Unmarshal(raw, &arr); err == nil {
		result := make([][32]byte, len(arr))
		for i, s := range arr {
			result[i] = [32]byte(common.HexToHash(s))
		}
		return result
	}
	return nil
}

func resolveFilterBlock(tag string, head uint64) (uint64, error) {
	if tag == "" || tag == "latest" || tag == "pending" {
		return head, nil
	}
	if tag == "earliest" {
		return 0, nil
	}
	if strings.HasPrefix(tag, "0x") {
		n, err := hexutil.DecodeUint64(tag)
		if err != nil {
			return 0, err
		}
		return n, nil
	}
	return 0, fmt.Errorf("invalid block tag: %s", tag)
}
