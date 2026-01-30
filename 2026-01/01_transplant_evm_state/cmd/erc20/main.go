package main

import (
	"context"
	"crypto/ecdsa"
	"fmt"
	"math/big"
	"os"
	"strings"
	"time"

	"github.com/ava-labs/libevm"
	"github.com/ava-labs/libevm/accounts/abi"
	"github.com/ava-labs/libevm/common"
	"github.com/ava-labs/libevm/core/types"
	"github.com/ava-labs/libevm/crypto"
	"github.com/ava-labs/libevm/ethclient"
)

// Simple ERC20 contract bytecode (name="Test", symbol="TST", 18 decimals, mints 1M to deployer)
// Compiled from minimal ERC20 with: constructor mints 1_000_000 * 10^18 to msg.sender
const contractBytecode = "608060405234801561001057600080fd5b506c0c9f2c9cd04674edea40000000600160003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020819055506c0c9f2c9cd04674edea400000006000819055506104fa806100866000396000f3fe608060405234801561001057600080fd5b50600436106100625760003560e01c806306fdde0314610067578063095ea7b31461008557806318160ddd146100b557806323b872dd146100d357806370a0823114610103578063a9059cbb14610133575b600080fd5b61006f610163565b60405161007c919061037a565b60405180910390f35b61009f600480360381019061009a9190610405565b61019c565b6040516100ac9190610460565b60405180910390f35b6100bd61028e565b6040516100ca919061048a565b60405180910390f35b6100ed60048036038101906100e891906104a5565b610294565b6040516100fa9190610460565b60405180910390f35b61011d600480360381019061011891906104f8565b610395565b60405161012a919061048a565b60405180910390f35b61014d60048036038101906101489190610405565b6103ad565b60405161015a9190610460565b60405180910390f35b6040518060400160405280600481526020017f546573740000000000000000000000000000000000000000000000000000000081525081565b600081600260003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060008573ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020819055508273ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff167f8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b92584604051610282919061048a565b60405180910390a36001905092915050565b60005481565b600081600160008673ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020019081526020016000205410156102e857600080fd5b81600160008673ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020600082825461033791906105ac565b9250508190555081600160008573ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020600082825461038d91906105e0565b925050819055506001905092915050565b60016020528060005260406000206000915090505481565b60006103ba338484610294565b905092915050565b600081519050919050565b600082825260208201905092915050565b60005b838110156103fc5780820151818401526020810190506103e1565b60008484015250505050565b6000601f19601f8301169050919050565b6000610424826103c2565b61042e81856103cd565b935061043e8185602086016103de565b61044781610408565b840191505092915050565b600060208201905081810360008301526104698184610419565b905092915050565b60008115159050919050565b61048681610471565b82525050565b6000602082019050610490600083018461047d565b92915050565b6000819050919050565b6104a981610496565b82525050565b6000602082019050816000830152506104c760008301846104a0565b92915050565b600080fd5b6104db81610496565b81146104e657600080fd5b50565b6000813590506104f8816104d2565b92915050565b600073ffffffffffffffffffffffffffffffffffffffff82169050919050565b6000610529826104fe565b9050919050565b6105398161051e565b811461054457600080fd5b50565b60008135905061055681610530565b92915050565b60008060408385031215610573576105726104cd565b5b600061058185828601610547565b9250506020610592858286016104e9565b9150509250929050565b60006020828403121561059257600080fd5b60006105a084828501610547565b91505092915050565b60006105b482610496565b91506105bf83610496565b92508282039050818111156105d7576105d6610614565b5b92915050565b60006105e882610496565b91506105f383610496565b925082820190508082111561060b5761060a610614565b5b92915050565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052601160045260246000fdfea264697066735822122000000000000000000000000000000000000000000000000000000000000000000064736f6c63430008130033"

const erc20ABI = `[{"inputs":[{"name":"to","type":"address"},{"name":"amount","type":"uint256"}],"name":"transfer","outputs":[{"name":"","type":"bool"}],"type":"function"},{"inputs":[{"name":"account","type":"address"}],"name":"balanceOf","outputs":[{"name":"","type":"uint256"}],"type":"function"}]`

func main() {
	if len(os.Args) < 3 {
		fmt.Println("Usage:")
		fmt.Println("  erc20 deploy <rpc-url>")
		fmt.Println("  erc20 transfer <rpc-url> <contract> <to> <amount>")
		fmt.Println("  erc20 balance <rpc-url> <contract> <address>")
		os.Exit(1)
	}

	cmd := os.Args[1]
	rpcURL := os.Args[2]

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	client, err := ethclient.DialContext(ctx, rpcURL)
	if err != nil {
		fmt.Printf("Failed to connect: %v\n", err)
		os.Exit(1)
	}
	defer client.Close()

	// EWOQ key
	privateKey, _ := crypto.HexToECDSA("56289e99c94b6912bfc12adc093c9b51124f0dc54ac7a766b2bc5ccf558d8027")

	switch cmd {
	case "deploy":
		deploy(ctx, client, privateKey)
	case "transfer":
		if len(os.Args) < 6 {
			fmt.Println("Usage: erc20 transfer <rpc-url> <contract> <to> <amount>")
			os.Exit(1)
		}
		contract := common.HexToAddress(os.Args[3])
		to := common.HexToAddress(os.Args[4])
		amount, _ := new(big.Int).SetString(os.Args[5], 10)
		transfer(ctx, client, privateKey, contract, to, amount)
	case "balance":
		if len(os.Args) < 5 {
			fmt.Println("Usage: erc20 balance <rpc-url> <contract> <address>")
			os.Exit(1)
		}
		contract := common.HexToAddress(os.Args[3])
		addr := common.HexToAddress(os.Args[4])
		balance(ctx, client, contract, addr)
	default:
		fmt.Printf("Unknown command: %s\n", cmd)
		os.Exit(1)
	}
}

func deploy(ctx context.Context, client *ethclient.Client, key *ecdsa.PrivateKey) {
	from := crypto.PubkeyToAddress(key.PublicKey)

	nonce, _ := client.PendingNonceAt(ctx, from)
	gasPrice, _ := client.SuggestGasPrice(ctx)
	chainID, _ := client.ChainID(ctx)

	bytecode := common.FromHex(contractBytecode)

	tx := types.NewTx(&types.LegacyTx{
		Nonce:    nonce,
		GasPrice: gasPrice,
		Gas:      2000000,
		Data:     bytecode,
	})

	signedTx, _ := types.SignTx(tx, types.NewEIP155Signer(chainID), key)
	if err := client.SendTransaction(ctx, signedTx); err != nil {
		fmt.Printf("Failed to send: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Deploy tx: %s\n", signedTx.Hash().Hex())
	fmt.Println("Waiting for confirmation...")

	time.Sleep(3 * time.Second)

	receipt, err := client.TransactionReceipt(ctx, signedTx.Hash())
	if err != nil {
		fmt.Printf("Failed to get receipt: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Contract deployed at: %s\n", receipt.ContractAddress.Hex())
}

func transfer(ctx context.Context, client *ethclient.Client, key *ecdsa.PrivateKey, contract, to common.Address, amount *big.Int) {
	from := crypto.PubkeyToAddress(key.PublicKey)

	parsedABI, _ := abi.JSON(strings.NewReader(erc20ABI))
	data, _ := parsedABI.Pack("transfer", to, amount)

	nonce, _ := client.PendingNonceAt(ctx, from)
	gasPrice, _ := client.SuggestGasPrice(ctx)
	chainID, _ := client.ChainID(ctx)

	tx := types.NewTx(&types.LegacyTx{
		Nonce:    nonce,
		To:       &contract,
		GasPrice: gasPrice,
		Gas:      100000,
		Data:     data,
	})

	signedTx, _ := types.SignTx(tx, types.NewEIP155Signer(chainID), key)
	if err := client.SendTransaction(ctx, signedTx); err != nil {
		fmt.Printf("Failed to send: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Transfer tx: %s\n", signedTx.Hash().Hex())
	fmt.Println("Waiting for confirmation...")
	time.Sleep(3 * time.Second)
	fmt.Println("Done")
}

func balance(ctx context.Context, client *ethclient.Client, contract, addr common.Address) {
	parsedABI, _ := abi.JSON(strings.NewReader(erc20ABI))
	data, _ := parsedABI.Pack("balanceOf", addr)

	msg := ethereum.CallMsg{
		To:   &contract,
		Data: data,
	}

	result, err := client.CallContract(ctx, msg, nil)
	if err != nil {
		fmt.Printf("Failed to call: %v\n", err)
		os.Exit(1)
	}

	bal := new(big.Int).SetBytes(result)
	fmt.Println(bal.String())
}
