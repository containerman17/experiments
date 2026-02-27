package main

import (
	"fmt"
	"math/big"

	"github.com/ava-labs/libevm/common"
	"github.com/ava-labs/libevm/core"
	"github.com/ava-labs/libevm/core/types"
	"github.com/ava-labs/libevm/core/vm"
)

func debugBlock(blockNum uint64, cacheDir string) {
	chainCfg := cchainConfig()
	parentBlock := blockNum - 1
	rpc := NewRPCClient(parentBlock)

	bd, err := LoadOrFetchBlock(rpc, blockNum, cacheDir)
	if err != nil {
		fmt.Printf("fetch error: %v\n", err)
		return
	}

	header, txs, canonReceipts, err := ParseBlock(bd, chainCfg.ChainID)
	if err != nil {
		fmt.Printf("parse error: %v\n", err)
		return
	}

	state := NewReplayState(rpc)
	signer := types.NewLondonSigner(chainCfg.ChainID)
	gasPool := new(core.GasPool).AddGas(header.GasLimit)

	random := common.Hash{1}
	blockCtx := vm.BlockContext{
		CanTransfer: core.CanTransfer,
		Transfer:    core.Transfer,
		GetHash:     func(n uint64) common.Hash { return rpc.FetchBlockHash(n) },
		Coinbase:    header.Coinbase,
		BlockNumber: header.Number,
		Time:        header.Time,
		Difficulty:  big.NewInt(0),
		Random:      &random,
		BaseFee:     header.BaseFee,
		GasLimit:    header.GasLimit,
	}

	rules := chainCfg.Rules(header.Number, true, header.Time)
	fmt.Printf("Rules: Berlin=%v London=%v Shanghai=%v Cancun=%v\n", rules.IsBerlin, rules.IsLondon, rules.IsShanghai, rules.IsCancun)
	fmt.Printf("Precompiles: %d\n", len(vm.ActivePrecompiles(rules)))
	fmt.Printf("Block: %d, txs: %d, gasLimit: %d, baseFee: %s\n", blockNum, len(txs), header.GasLimit, header.BaseFee.String())
	fmt.Printf("Coinbase: %s\n", header.Coinbase.Hex())
	fmt.Println()

	for i, tx := range txs {
		state.BeginTx(tx.Hash(), i)

		msg, err := core.TransactionToMessage(tx, signer, header.BaseFee)
		if err != nil {
			fmt.Printf("tx %d: message error: %v\n", i, err)
			continue
		}

		fmt.Printf("tx %d: hash=%s from=%s nonce=%d gas=%d\n", i, tx.Hash().Hex()[:18], msg.From.Hex()[:12], msg.Nonce, msg.GasLimit)
		fmt.Printf("  state nonce=%d balance=%s\n", state.GetNonce(msg.From), state.GetBalance(msg.From).String())
		if msg.To != nil {
			codeSize := state.GetCodeSize(*msg.To)
			fmt.Printf("  to=%s codeSize=%d\n", msg.To.Hex()[:12], codeSize)
		}

		txCtx := vm.TxContext{Origin: msg.From, GasPrice: msg.GasPrice}
		evm := vm.NewEVM(blockCtx, txCtx, state, chainCfg, vm.Config{})

		result, err := core.ApplyMessage(evm, msg, gasPool)
		if err != nil {
			fmt.Printf("  APPLY ERROR: %v\n", err)
			fmt.Println()
			continue
		}

		if result.RefundedGas > 0 {
			gasPool.SubGas(result.RefundedGas)
			result.UsedGas += result.RefundedGas
			result.RefundedGas = 0
		}

		state.CommitTx()

		canonGas := hexToUint64(canonReceipts[i].GasUsed)
		canonStatus := canonReceipts[i].StatusUint()
		replayStatus := uint64(1)
		if result.Failed() {
			replayStatus = 0
		}

		match := "OK"
		if canonStatus != replayStatus {
			match = "STATUS MISMATCH"
		} else if canonGas != result.UsedGas {
			match = fmt.Sprintf("GAS DELTA %+d", int64(result.UsedGas)-int64(canonGas))
		}
		fmt.Printf("  result: failed=%v gasUsed=%d canonGas=%d err=%v [%s]\n", result.Failed(), result.UsedGas, canonGas, result.Err, match)
		if result.Failed() && len(result.ReturnData) > 0 {
			fmt.Printf("  revert data: %x\n", result.ReturnData[:min64(64, len(result.ReturnData))])
		}
		fmt.Println()

		if i >= 5 {
			fmt.Println("... (stopping debug after 6 txs)")
			break
		}
	}
}

func min64(a, b int) int {
	if a < b {
		return a
	}
	return b
}
