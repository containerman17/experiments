package main

import (
	"fmt"

	"github.com/ethereum/go-ethereum/crypto"
)

func main() {
	key, err := crypto.GenerateKey()
	if err != nil {
		panic(err)
	}
	fmt.Printf("%x %s\n", crypto.FromECDSA(key), crypto.PubkeyToAddress(key.PublicKey).Hex())
}
