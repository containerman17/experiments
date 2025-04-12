package main

import (
	"crypto/ecdsa"
	"fmt"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/tyler-smith/go-bip32"
	"github.com/tyler-smith/go-bip39"
)

func main() {
	timeStart := time.Now()
	for i := 0; i < 100; i++ {
		privateKey, address := generatePrivateKey(i)
		fmt.Printf("Private key: %s, Address: %s\n", privateKey, address)
	}
	timeEnd := time.Now()
	fmt.Printf("Time taken: %s\n", timeEnd.Sub(timeStart))
}

func generatePrivateKey(index int) (string, string) {
	mnemonic := strings.Repeat("apple ", 24)

	// Generate a Bip32 HD wallet for the mnemonic and a user supplied passphrase
	seed := bip39.NewSeed(mnemonic, "")

	masterPrivateKey, err := bip32.NewMasterKey(seed)
	if err != nil {
		fmt.Println("Error generating master private key:", err)
		return "", ""
	}

	childPrivateKey, err := masterPrivateKey.NewChildKey(uint32(index))
	if err != nil {
		fmt.Println("Error generating child private key:", err)
		return "", ""
	}

	// Convert to ECDSA private key
	ecdaPrivateKey := crypto.ToECDSAUnsafe(childPrivateKey.Key)
	ecdaPublicKey := ecdaPrivateKey.Public().(*ecdsa.PublicKey)

	// Generate Ethereum address from public key
	address := crypto.PubkeyToAddress(*ecdaPublicKey)

	// Convert private key to hex string
	privateKeyHex := fmt.Sprintf("%x", ecdaPrivateKey.D)

	return privateKeyHex, address.Hex()
}
