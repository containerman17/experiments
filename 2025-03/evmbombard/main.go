package main

import (
	"context"
	"crypto/ecdsa"
	"flag"
	"fmt"
	"log"
	"math/big"
	"strings"
	"time"

	"github.com/containerman17/experiments/2025-03/evmbombard/contracts"
	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"
)

var batchSize int
var keyCount int
var solidityArgument uint64
var loadType string

const timeoutSeconds = 10

func main() {
	// Parse command line arguments
	flag.IntVar(&batchSize, "batch", 15, "Size of transaction batches")
	flag.IntVar(&keyCount, "keys", 600, "Number of private keys to generate")
	flag.Uint64Var(&solidityArgument, "arg", 1, "Argument to pass to the contract (load)")
	flag.StringVar(&loadType, "load", "transfer", "Type of load to apply to the contract (cpu, storage, transfer)")

	if loadType == "transfer" && solidityArgument != 1 {
		log.Fatalf("No need to specify an argument for transfers")
	}

	if loadType != "cpu" && loadType != "storage" && loadType != "transfer" {
		log.Fatalf("Invalid load type. Must be one of: cpu, storage, transfer")
	}

	var rpcUrlsArg string
	flag.StringVar(&rpcUrlsArg, "rpc", "", "Comma-separated list of RPC URLs")

	flag.Parse()

	fmt.Printf("Starting with batch size: %d, key count: %d\n", batchSize, keyCount)

	// Parse RPC URLs from command line
	var rpcUrls []string
	if rpcUrlsArg != "" {
		rpcUrls = strings.Split(rpcUrlsArg, ",")
	} else {
		// No default URLs - require user to provide them
		log.Fatal("No RPC URLs provided. Use -rpc flag to provide at least one URL.\n" +
			"Example: -rpc \"http://127.0.0.1:9650/ext/bc/chainID/rpc\"\n" +
			"Note: WebSocket endpoints (ws:// or wss://) are preferred for better performance.\n" +
			"HTTP endpoints will be automatically converted to WebSocket endpoints.")
	}

	// Filter out empty RPC URLs
	filteredUrls := make([]string, 0)
	for _, url := range rpcUrls {
		if url != "" {
			filteredUrls = append(filteredUrls, url)
		}
	}
	rpcUrls = filteredUrls

	// Check if there's at least one RPC URL
	if len(rpcUrls) == 0 {
		log.Fatal("No valid RPC URLs provided. Use -rpc flag to provide at least one URL.")
	}

	fmt.Printf("Using %d RPC URLs\n", len(rpcUrls))

	// Convert HTTP URLs to WebSocket URLs
	for i, rpcUrl := range rpcUrls {
		if strings.HasPrefix(rpcUrl, "http") {
			rpcUrl = strings.Replace(rpcUrl, "http", "ws", 1)
		}
		if strings.HasSuffix(rpcUrl, "/rpc") {
			rpcUrl = strings.Replace(rpcUrl, "/rpc", "/ws", 1)
		}
		rpcUrls[i] = rpcUrl
	}

	// Initialize clients
	clients := make([]*ethclient.Client, len(rpcUrls))
	for i, rpcUrl := range rpcUrls {
		client, err := ethclient.Dial(rpcUrl)
		if err != nil {
			log.Fatal("failed to create tx listener", "err", err, "rpcUrl: ", rpcUrl)
		}
		clients[i] = client
	}

	txListener := NewTxListener(clients)

	go txListener.Start(context.Background())

	keys := mustGenPrivateKeys(keyCount)

	err := fund(clients[0], keys, txListener, 50)
	if err != nil {
		log.Fatalf("failed to fund: %v", err)
	}

	var data []byte
	if loadType == "cpu" {
		data = contracts.GetCPUPayloadData(solidityArgument)
	} else if loadType == "storage" {
		log.Fatalf("Storage load not implemented")
	}

	var receiver common.Address
	// if loadType != "transfer" {
	// Deploy contract using the first client and first key
	chainID, err := clients[0].NetworkID(context.Background())
	if err != nil {
		log.Fatalf("failed to get chain ID: %v", err)
	}

	deployerKey := keys[0]
	auth, err := bind.NewKeyedTransactorWithChainID(deployerKey, chainID)
	if err != nil {
		log.Fatalf("failed to create keyed transactor: %v", err)
	}
	auth.GasLimit = 4000000
	auth.GasPrice = big.NewInt(GWEI * 2)

	// Deploy contract
	addr, tx, _, err := contracts.DeployContracts(auth, clients[0])
	if err != nil {
		log.Fatalf("failed to deploy contract: %v", err)
	}

	// Wait for the transaction to be mined
	err = txListener.AwaitTxMined(tx.Hash().String(), 30) // Longer timeout for contract deployment
	if err != nil {
		log.Fatalf("contract deployment transaction failed: %v", err)
	}

	receiver = addr
	fmt.Printf("Contract deployed at: %s\n", receiver.Hex())
	// }

	fmt.Printf("Starting bombardment to address: %s\n", receiver.Hex())

	clientNumber := 0
	for _, key := range keys {
		go func(key *ecdsa.PrivateKey) {
			clientNumber++
			bombardWithTransactions(clients[clientNumber%len(clients)], key, txListener, data, receiver)
		}(key)
		pause := 20000 / keyCount
		time.Sleep(time.Duration(pause) * time.Millisecond)
	}

	// Wait indefinitely
	select {}
}
