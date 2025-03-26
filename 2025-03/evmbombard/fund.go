package main

import (
	"context"
	"crypto/ecdsa"
	"fmt"
	"log"
	"math/big"
	"sync"

	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
)

// eth address: 0x8db97C7cEcE249c2b98bDC0226Cc4C2A57BF52FC
const hardHatKeyStr = "56289e99c94b6912bfc12adc093c9b51124f0dc54ac7a766b2bc5ccf558d8027"

var fundAmount *big.Int

func init() {
	var ok bool
	fundAmount, ok = new(big.Int).SetString("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffff", 0)
	if !ok {
		log.Fatal("failed to set fund amount")
	}
}

func fund(client *ethclient.Client, keys []*ecdsa.PrivateKey, listener *TxListener, batchSize int) error {
	// Handle empty keys array
	if len(keys) == 0 {
		return nil
	}

	// First check which accounts need funding in parallel
	var wg sync.WaitGroup
	var mu sync.Mutex
	accountsToFund := make([]*ecdsa.PrivateKey, 0)
	targetBalance := fundAmount
	errChan := make(chan error, len(keys))

	// Limit concurrency to avoid overwhelming the RPC
	concurrencyLimit := 100
	sem := make(chan struct{}, concurrencyLimit)

	for _, key := range keys {
		sem <- struct{}{} // Acquire token
		wg.Add(1)
		go func(key *ecdsa.PrivateKey) {
			defer wg.Done()
			defer func() { <-sem }() // Release token

			address := crypto.PubkeyToAddress(key.PublicKey)
			balance, err := client.BalanceAt(context.Background(), address, nil)
			if err != nil {
				errChan <- fmt.Errorf("failed to get balance for address %s: %w", address.Hex(), err)
				return
			}

			if balance.Cmp(targetBalance) < 0 {
				mu.Lock()
				accountsToFund = append(accountsToFund, key)
				mu.Unlock()
			}
		}(key)
	}

	wg.Wait()
	close(errChan)

	// Check if any balance checks failed
	for err := range errChan {
		if err != nil {
			return err
		}
	}

	if len(accountsToFund) == 0 {
		fmt.Println("all accounts already have sufficient balance")
		return nil
	}

	fmt.Printf("funding %d accounts\n", len(accountsToFund))

	batchCount := len(accountsToFund) / batchSize
	// Process full batches
	for i := 0; i < batchCount; i++ {
		batchKeys := accountsToFund[i*batchSize : (i+1)*batchSize]
		err := fundBatch(client, batchKeys, listener)
		if err != nil {
			return err
		}
	}

	// Process remaining keys
	remainingKeys := accountsToFund[batchCount*batchSize:]
	if len(remainingKeys) > 0 {
		err := fundBatch(client, remainingKeys, listener)
		if err != nil {
			return err
		}
	}

	fmt.Println("all accounts funded")
	return nil
}

func fundBatch(client *ethclient.Client, keys []*ecdsa.PrivateKey, listener *TxListener) error {
	privateKey, err := crypto.HexToECDSA(hardHatKeyStr)
	if err != nil {
		return fmt.Errorf("failed to parse private key: %w", err)
	}

	fromAddress := crypto.PubkeyToAddress(privateKey.PublicKey)

	nonce, err := client.PendingNonceAt(context.Background(), fromAddress)
	if err != nil {
		return fmt.Errorf("failed to get nonce: %w", err)
	}

	gasLimit := uint64(21000)
	// Fund with double the amount
	value := new(big.Int).Mul(fundAmount, big.NewInt(2))
	gasPrice := big.NewInt(GWEI * 1)

	chainID, err := client.NetworkID(context.Background())
	if err != nil {
		return fmt.Errorf("failed to get chain ID: %w", err)
	}

	signedTxs := make([]*types.Transaction, 0, len(keys))
	for _, key := range keys {
		to := crypto.PubkeyToAddress(key.PublicKey)
		var data []byte
		tx := types.NewTransaction(nonce, to, value, gasLimit, gasPrice, data)

		signedTx, err := types.SignTx(tx, types.NewEIP155Signer(chainID), privateKey)
		if err != nil {
			log.Fatal(err)
		}

		signedTxs = append(signedTxs, signedTx)

		nonce++
	}

	// Send all transactions first
	var txHashesMutex sync.Mutex
	txHashes := make([]string, 0, len(signedTxs))
	var wg sync.WaitGroup
	errChan := make(chan error, len(signedTxs))

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

	// Check if any transactions failed to send
	for err := range errChan {
		if err != nil {
			return err
		}
	}

	// Wait for all transactions to be mined
	for _, hash := range txHashes {
		if err := listener.AwaitTxMined(hash, 10); err != nil {
			return fmt.Errorf("transaction failed to mine: %w", err)
		}
	}

	return nil
}
