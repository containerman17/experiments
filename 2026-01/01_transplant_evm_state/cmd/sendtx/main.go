package main

import (
	"context"
	"crypto/ecdsa"
	"fmt"
	"math/big"
	"os"
	"time"

	"github.com/ava-labs/libevm/common"
	"github.com/ava-labs/libevm/core/types"
	"github.com/ava-labs/libevm/crypto"
	"github.com/ava-labs/libevm/ethclient"
)

func main() {
	if len(os.Args) < 4 {
		fmt.Println("Usage: sendtx <rpc-url> <to-address> <amount-wei>")
		fmt.Println("Uses EWOQ key (pre-funded on local networks)")
		os.Exit(1)
	}

	rpcURL := os.Args[1]
	toAddr := common.HexToAddress(os.Args[2])
	amount, ok := new(big.Int).SetString(os.Args[3], 10)
	if !ok {
		fmt.Println("Invalid amount")
		os.Exit(1)
	}

	// EWOQ private key (pre-funded on local Avalanche networks)
	privateKey, _ := crypto.HexToECDSA("56289e99c94b6912bfc12adc093c9b51124f0dc54ac7a766b2bc5ccf558d8027")
	fromAddr := crypto.PubkeyToAddress(privateKey.PublicKey)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	client, err := ethclient.DialContext(ctx, rpcURL)
	if err != nil {
		fmt.Printf("Failed to connect: %v\n", err)
		os.Exit(1)
	}
	defer client.Close()

	if err := sendTx(ctx, client, privateKey, fromAddr, toAddr, amount); err != nil {
		fmt.Printf("Failed: %v\n", err)
		os.Exit(1)
	}
}

func sendTx(ctx context.Context, client *ethclient.Client, key *ecdsa.PrivateKey, from, to common.Address, amount *big.Int) error {
	nonce, err := client.PendingNonceAt(ctx, from)
	if err != nil {
		return fmt.Errorf("get nonce: %w", err)
	}

	gasPrice, err := client.SuggestGasPrice(ctx)
	if err != nil {
		return fmt.Errorf("get gas price: %w", err)
	}

	chainID, err := client.ChainID(ctx)
	if err != nil {
		return fmt.Errorf("get chain id: %w", err)
	}

	tx := types.NewTx(&types.LegacyTx{
		Nonce:    nonce,
		To:       &to,
		Value:    amount,
		Gas:      21000,
		GasPrice: gasPrice,
	})

	signedTx, err := types.SignTx(tx, types.NewEIP155Signer(chainID), key)
	if err != nil {
		return fmt.Errorf("sign tx: %w", err)
	}

	if err := client.SendTransaction(ctx, signedTx); err != nil {
		return fmt.Errorf("send tx: %w", err)
	}

	fmt.Printf("Tx sent: %s\n", signedTx.Hash().Hex())

	// Wait for confirmation
	for i := 0; i < 10; i++ {
		time.Sleep(500 * time.Millisecond)
		receipt, err := client.TransactionReceipt(ctx, signedTx.Hash())
		if err == nil && receipt != nil {
			fmt.Printf("Confirmed in block %d\n", receipt.BlockNumber.Uint64())
			return nil
		}
	}

	fmt.Println("Tx sent, waiting for confirmation...")
	return nil
}
