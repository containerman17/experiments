// generate_keys generates two wallets (user and custodian) for testing
// the Java P→C import SDK.
//
// Usage: go run main.go [--network fuji|mainnet]
//
// Output: Writes .env file with all keys and addresses
package main

import (
	"encoding/hex"
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/ava-labs/avalanchego/ids"
	"github.com/ava-labs/avalanchego/utils/constants"
	"github.com/ava-labs/avalanchego/utils/crypto/secp256k1"
	"github.com/ava-labs/avalanchego/utils/formatting/address"
	"github.com/ava-labs/libevm/crypto"
)

func main() {
	network := flag.String("network", "fuji", "Network: fuji or mainnet")
	output := flag.String("output", ".env", "Output file path")
	flag.Parse()

	// Determine HRP based on network
	var hrp string
	var networkID uint32
	switch strings.ToLower(*network) {
	case "fuji", "testnet":
		hrp = constants.FujiHRP
		networkID = constants.FujiID
	case "mainnet", "avax":
		hrp = constants.MainnetHRP
		networkID = constants.MainnetID
	default:
		fmt.Fprintf(os.Stderr, "Unknown network: %s\n", *network)
		os.Exit(1)
	}

	fmt.Printf("=== Avalanche Test Wallet Generator ===\n")
	fmt.Printf("Network: %s (ID: %d, HRP: %s)\n\n", *network, networkID, hrp)

	// Generate User wallet
	fmt.Println("Generating User wallet...")
	userPrivKey, userPAddr, userCBech32, userEVM, err := generateWallet(hrp)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to generate user wallet: %v\n", err)
		os.Exit(1)
	}

	// Generate Custodian wallet
	fmt.Println("Generating Custodian wallet...")
	custodianPrivKey, custodianPAddr, custodianCBech32, custodianEVM, err := generateWallet(hrp)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to generate custodian wallet: %v\n", err)
		os.Exit(1)
	}

	// Display wallets
	fmt.Println("\n" + strings.Repeat("=", 60))
	fmt.Println("USER WALLET")
	fmt.Println(strings.Repeat("=", 60))
	fmt.Printf("Private Key:     0x%s\n", userPrivKey)
	fmt.Printf("P-Chain Address: %s\n", userPAddr)
	fmt.Printf("C-Chain Bech32:  %s\n", userCBech32)
	fmt.Printf("C-Chain EVM:     %s\n", userEVM)

	fmt.Println("\n" + strings.Repeat("=", 60))
	fmt.Println("CUSTODIAN WALLET")
	fmt.Println(strings.Repeat("=", 60))
	fmt.Printf("Private Key:     0x%s\n", custodianPrivKey)
	fmt.Printf("P-Chain Address: %s\n", custodianPAddr)
	fmt.Printf("C-Chain Bech32:  %s\n", custodianCBech32)
	fmt.Printf("C-Chain EVM:     %s\n", custodianEVM)

	// Write .env file
	envContent := fmt.Sprintf(`# Avalanche Test Wallets
# Generated for network: %s
# 
# IMPORTANT: Keep private keys secret!

# Network configuration
NETWORK=%s
NETWORK_ID=%d
NODE_URL=https://api.avax-test.network

# User wallet (simulates customer sending funds)
USER_PRIVATE_KEY=0x%s
USER_P_ADDRESS=%s
USER_C_BECH32=%s
USER_C_EVM=%s

# Custodian wallet (bank/exchange receiving funds)
CUSTODIAN_PRIVATE_KEY=0x%s
CUSTODIAN_P_ADDRESS=%s
CUSTODIAN_C_BECH32=%s
CUSTODIAN_C_EVM=%s
`,
		*network, *network, networkID,
		userPrivKey, userPAddr, userCBech32, userEVM,
		custodianPrivKey, custodianPAddr, custodianCBech32, custodianEVM,
	)

	if err := os.WriteFile(*output, []byte(envContent), 0600); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to write %s: %v\n", *output, err)
		os.Exit(1)
	}

	fmt.Printf("\n✓ Wallets saved to: %s\n", *output)
	fmt.Println("\nNEXT STEPS:")
	fmt.Println("1. Fund USER's C-Chain address with testnet AVAX")
	fmt.Printf("   Faucet: https://faucet.avax.network/\n")
	fmt.Printf("   Address: %s\n", userEVM)
	fmt.Println("2. Run: go run cmd/prepare_test/main.go")
}

// generateWallet creates a new secp256k1 key and derives all address formats
func generateWallet(hrp string) (privKeyHex, pAddr, cBech32, evmAddr string, err error) {
	// Generate new private key using avalanchego's factory
	privKey, err := secp256k1.NewPrivateKey()
	if err != nil {
		return "", "", "", "", fmt.Errorf("generate key: %w", err)
	}

	// Get raw private key bytes
	privKeyBytes := privKey.Bytes()
	privKeyHex = hex.EncodeToString(privKeyBytes)

	// Get short ID (20-byte address)
	shortID := privKey.Address()

	// Format P-Chain address (P-{hrp}1...)
	pAddr, err = address.Format("P", hrp, shortID[:])
	if err != nil {
		return "", "", "", "", fmt.Errorf("format P-chain address: %w", err)
	}

	// Format C-Chain Bech32 address (C-{hrp}1...)
	cBech32, err = address.Format("C", hrp, shortID[:])
	if err != nil {
		return "", "", "", "", fmt.Errorf("format C-chain bech32 address: %w", err)
	}

	// Derive EVM address (different derivation path)
	// EVM uses keccak256(uncompressed_pubkey[1:])[12:32]
	ecdsaPrivKey, err := crypto.ToECDSA(privKeyBytes)
	if err != nil {
		return "", "", "", "", fmt.Errorf("convert to ecdsa: %w", err)
	}
	evmAddress := crypto.PubkeyToAddress(ecdsaPrivKey.PublicKey)
	evmAddr = evmAddress.Hex()

	return privKeyHex, pAddr, cBech32, evmAddr, nil
}

// Helper to format chain IDs for display
func formatChainID(id ids.ID) string {
	if id == ids.Empty {
		return "P-Chain (all zeros)"
	}
	return id.String()
}
