package main

import (
	"context"
	"crypto/ecdsa"
	"fmt"
	"math/big"
	"sync"
	"time"

	"log"

	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
)

var errorCount = 0
var lastError string

func init() {
	go func() {
		for {
			if errorCount > 0 {
				fmt.Printf("Errors: %d, Last error: %s\n", errorCount, lastError)
				errorCount = 0
				lastError = ""
			}
			time.Sleep(3 * time.Second)
		}
	}()
}

const GWEI = 1000000000

var gasPrice = int64(GWEI * 1)

func bombardWithTransactions(client *ethclient.Client, key *ecdsa.PrivateKey, listener *TxListener, data []byte, receiver common.Address) {
	fromAddress := crypto.PubkeyToAddress(key.PublicKey)

	gasLimit := uint64(10_000_000)
	chainID, err := client.NetworkID(context.Background())
	if err != nil {
		log.Printf("failed to get chain ID: %v", err)
		return
	}

	shouldRefetchNonce := true

	nonce := uint64(0)

	for {
		// Re-fetch nonce if previous transactions had errors
		if shouldRefetchNonce {
			newNonce, err := client.PendingNonceAt(context.Background(), fromAddress)
			if err != nil {
				log.Printf("failed to refresh nonce: %v", err)
				time.Sleep(1 * time.Second)
				continue
			}
			nonce = newNonce
			shouldRefetchNonce = false
		}

		signedTxs := make([]*types.Transaction, 0, batchSize)
		for i := 0; i < batchSize; i++ {
			// Pack the function call to simulateTransfer with recipient and amount
			// consumeCPUAbi, _ := abi.JSON(strings.NewReader(`[{"inputs":[{"internalType":"uint64","name":"intensity","type":"uint64"}],"name":"consumeCPU","outputs":[],"stateMutability":"nonpayable","type":"function"}]`))
			// data, _ := consumeCPUAbi.Pack("consumeCPU", uint64(22))

			// consumeCPUAbi, _ := abi.JSON(strings.NewReader(`[{"inputs":[{"internalType":"uint64","name":"intensity","type":"uint64"}],"name":"consumeCPU","outputs":[],"stateMutability":"nonpayable","type":"function"}]`))
			// data, _ := consumeCPUAbi.Pack("consumeCPU", uint64(22))

			simulateTransferAbi, _ := abi.JSON(strings.NewReader(`[{"inputs":[{"internalType":"address","name":"to","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"simulateTransfer","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"}]`))
			data, _ := simulateTransferAbi.Pack("simulateTransfer", receiver, big.NewInt(1000))

			tx := types.NewTransaction(nonce, receiver, big.NewInt(0), gasLimit, big.NewInt(gasPrice), data)

			signedTx, err := types.SignTx(tx, types.NewEIP155Signer(chainID), key)
			if err != nil {
				log.Fatalf("failed to sign transaction: %v", err)
			}

			signedTxs = append(signedTxs, signedTx)
			nonce++
		}

		var txHashesMutex sync.Mutex
		txHashes := make([]string, 0, len(signedTxs))
		var wg sync.WaitGroup
		errChan := make(chan error, len(signedTxs))
		hasError := false

		for _, signedTx := range signedTxs {
			wg.Add(1)
			go func(tx *types.Transaction) {
				defer wg.Done()

				err := client.SendTransaction(context.Background(), tx)
				if err != nil {
					errChan <- fmt.Errorf("failed to send transaction: %w", err)
					return
				}

				txHashesMutex.Lock()
				txHashes = append(txHashes, tx.Hash().String())
				txHashesMutex.Unlock()
			}(signedTx)
		}

		wg.Wait()
		close(errChan)

		// Log any transaction send errors
		for err := range errChan {
			if err != nil {
				lastError = err.Error()
				errorCount++
				hasError = true
			}
		}

		// If we had errors, mark that we should refetch the nonce
		if hasError {
			shouldRefetchNonce = true
			time.Sleep(1 * time.Second)
			continue
		}

		// Wait for all transactions to be mined
		for _, hash := range txHashes {
			if err := listener.AwaitTxMined(hash, timeoutSeconds); err != nil {
				lastError = err.Error()
				errorCount++
				shouldRefetchNonce = true
				time.Sleep(1 * time.Second)
			}
		}
	}
}

// func isTransactionUnderpriced(err error) bool {
// 	if strings.HasSuffix(err.Error(), ": transaction underpriced") {
// 		return true
// 	}

// 	if strings.Contains(err.Error(), "< pool minimum fee cap") {
// 		return true
// 	}

// 	return false
// }
