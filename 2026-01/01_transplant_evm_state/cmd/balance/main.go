package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/ava-labs/libevm/common"
	"github.com/ava-labs/libevm/ethclient"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Println("Usage: balance <rpc-url> <address>")
		os.Exit(1)
	}

	rpcURL := os.Args[1]
	addr := common.HexToAddress(os.Args[2])

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	client, err := ethclient.DialContext(ctx, rpcURL)
	if err != nil {
		fmt.Printf("Failed to connect: %v\n", err)
		os.Exit(1)
	}
	defer client.Close()

	balance, err := client.BalanceAt(ctx, addr, nil)
	if err != nil {
		fmt.Printf("Failed to get balance: %v\n", err)
		os.Exit(1)
	}

	fmt.Println(balance.String())
}
