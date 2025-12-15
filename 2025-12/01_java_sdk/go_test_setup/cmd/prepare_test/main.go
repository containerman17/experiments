// prepare_test sets up UTXOs for testing the Java P→C import SDK.
package main

import (
	"context"
	"fmt"
	"math/rand"
	"os"
	"time"

	"github.com/ava-labs/avalanchego/ids"
	"github.com/ava-labs/avalanchego/utils/constants"
	"github.com/ava-labs/avalanchego/utils/crypto/secp256k1"
	"github.com/ava-labs/avalanchego/utils/formatting/address"
	"github.com/ava-labs/avalanchego/utils/set"
	"github.com/ava-labs/avalanchego/vms/components/avax"
	"github.com/ava-labs/avalanchego/vms/secp256k1fx"
	"github.com/ava-labs/avalanchego/wallet/subnet/primary"
	"github.com/ava-labs/avalanchego/wallet/subnet/primary/common"
	"github.com/ava-labs/libevm/crypto"
	"github.com/joho/godotenv"
)

func main() {
	if err := godotenv.Load(); err != nil {
		fmt.Printf("Warning: Could not load .env file: %v\n", err)
	}

	fmt.Println("Avalanche Test Setup: Prepare UTXOs for Java Import")
	fmt.Println()

	nodeURL := getEnv("NODE_URL", "https://api.avax-test.network")
	userPrivKeyHex := mustGetEnv("USER_PRIVATE_KEY")
	custodianCBech32 := mustGetEnv("CUSTODIAN_C_BECH32")

	// Parse user's private key
	userPrivKey, err := crypto.HexToECDSA(strip0x(userPrivKeyHex))
	if err != nil {
		fatal("Invalid USER_PRIVATE_KEY: %v", err)
	}

	// Convert to secp256k1 format for avalanchego
	userSecpKey, err := secp256k1.ToPrivateKey(crypto.FromECDSA(userPrivKey))
	if err != nil {
		fatal("Failed to convert key: %v", err)
	}

	// Parse custodian's C-Chain Bech32 address to get short ID
	custodianShortID, err := parseBech32Address(custodianCBech32)
	if err != nil {
		fatal("Invalid CUSTODIAN_C_BECH32: %v", err)
	}

	// Random amount: 0.001 * rand(0,1) AVAX = 0 to 0.001 AVAX
	// In nAVAX: 0 to 1,000,000 nAVAX (P-Chain uses 9 decimals)
	rand.Seed(time.Now().UnixNano())
	randomFactor := rand.Float64()
	amountNAvax := uint64(1_000_000 * randomFactor) // 0.001 AVAX max
	if amountNAvax < 100_000 {
		amountNAvax = 100_000 // minimum 0.0001 AVAX
	}

	fmt.Printf("Node: %s\n", nodeURL)
	fmt.Printf("Amount: %d nAVAX (%.6f AVAX)\n", amountNAvax, float64(amountNAvax)/1e9)
	fmt.Printf("Custodian C-Chain: %s\n", custodianCBech32)
	fmt.Println()

	ctx := context.Background()

	// Create keychain
	keychain := secp256k1fx.NewKeychain(userSecpKey)

	// Create wallet
	fmt.Println("Creating wallet...")
	wallet, err := primary.MakeWallet(
		ctx,
		nodeURL,
		keychain, // avaxKeychain
		keychain, // ethKeychain (secp256k1fx.Keychain implements both)
		primary.WalletConfig{},
	)
	if err != nil {
		fatal("Failed to create wallet: %v", err)
	}

	pWallet := wallet.P()
	cWallet := wallet.C()

	userPAddr := userSecpKey.Address()
	fmt.Printf("User P-Chain address: %s\n", userPAddr)
	fmt.Println()

	// Get AVAX asset ID from context
	avaxAssetID := cWallet.Builder().Context().AVAXAssetID

	// ═══════════════════════════════════════════════════════════════════
	// Step 1: C→P Export (User's C-Chain → User's P-Chain)
	// ═══════════════════════════════════════════════════════════════════
	fmt.Println("Step 1: C→P Export")

	exportTx, err := cWallet.IssueExportTx(
		constants.PlatformChainID,
		[]*secp256k1fx.TransferOutput{{
			Amt: amountNAvax,
			OutputOwners: secp256k1fx.OutputOwners{
				Threshold: 1,
				Addrs:     []ids.ShortID{userPAddr},
			},
		}},
		common.WithContext(ctx),
	)
	if err != nil {
		fatal("C→P Export failed: %v", err)
	}
	fmt.Printf("  TxID: %s\n", exportTx.ID())

	// Wait for acceptance
	fmt.Println("  Waiting for acceptance...")
	time.Sleep(3 * time.Second)

	// ═══════════════════════════════════════════════════════════════════
	// Step 2: P Import (User claims on P-Chain)
	// ═══════════════════════════════════════════════════════════════════
	fmt.Println("Step 2: P Import")

	importTx, err := pWallet.IssueImportTx(
		cWallet.Builder().Context().BlockchainID,
		&secp256k1fx.OutputOwners{
			Threshold: 1,
			Addrs:     []ids.ShortID{userPAddr},
		},
		common.WithContext(ctx),
	)
	if err != nil {
		fatal("P Import failed: %v", err)
	}
	fmt.Printf("  TxID: %s\n", importTx.ID())

	fmt.Println("  Waiting for acceptance...")
	time.Sleep(3 * time.Second)

	// Refresh wallet to see new UTXOs
	fmt.Println("  Refreshing wallet...")
	wallet, err = primary.MakeWallet(
		ctx,
		nodeURL,
		keychain,
		keychain,
		primary.WalletConfig{},
	)
	if err != nil {
		fatal("Failed to refresh wallet: %v", err)
	}
	pWallet = wallet.P()
	cWallet = wallet.C()

	// ═══════════════════════════════════════════════════════════════════
	// Step 3: P→C Export (User's P-Chain → Custodian's C-Chain)
	// ═══════════════════════════════════════════════════════════════════
	fmt.Println("Step 3: P→C Export to Custodian")

	// Get actual P-Chain balance (after fees from step 2)
	pBalance, err := pWallet.Builder().GetBalance()
	if err != nil {
		fatal("Failed to get P-Chain balance: %v", err)
	}

	availableBalance := pBalance[avaxAssetID]
	if availableBalance == 0 {
		fatal("No AVAX balance on P-Chain")
	}

	// Subtract P→C export fee (typically ~15000 nAVAX)
	const pExportFee = 100_000 // buffer for export tx fee to not worry about running out of funds
	if availableBalance <= pExportFee {
		fatal("Insufficient P-Chain balance after fees: %d nAVAX", availableBalance)
	}
	exportAmount := availableBalance - pExportFee

	fmt.Printf("  Available P-Chain balance: %d nAVAX, exporting: %d nAVAX\n", availableBalance, exportAmount)

	pExportTx, err := pWallet.IssueExportTx(
		cWallet.Builder().Context().BlockchainID,
		[]*avax.TransferableOutput{{
			Asset: avax.Asset{ID: avaxAssetID},
			Out: &secp256k1fx.TransferOutput{
				Amt: exportAmount,
				OutputOwners: secp256k1fx.OutputOwners{
					Threshold: 1,
					Addrs:     []ids.ShortID{custodianShortID},
				},
			},
		}},
		common.WithContext(ctx),
	)
	if err != nil {
		fatal("P→C Export failed: %v", err)
	}
	fmt.Printf("  TxID: %s\n", pExportTx.ID())

	fmt.Println()
	fmt.Println("════════════════════════════════════════════════════════════")
	fmt.Println("Done! UTXO created for custodian.")
	fmt.Printf("Amount: %d nAVAX (%.6f AVAX)\n", exportAmount, float64(exportAmount)/1e9)
	fmt.Printf("Custodian address: %s\n", custodianCBech32)
	fmt.Println()
	fmt.Println("Java SDK can now import this UTXO.")
	fmt.Println("════════════════════════════════════════════════════════════")
}

func parseBech32Address(addr string) (ids.ShortID, error) {
	// Strip chain prefix (C-fuji1... or C-avax1...)
	if len(addr) > 2 && addr[1] == '-' {
		addr = addr[2:]
	}

	hrp, addrBytes, err := address.ParseBech32(addr)
	if err != nil {
		return ids.ShortID{}, fmt.Errorf("parse bech32: %w", err)
	}

	// Validate HRP
	validHRPs := set.Of(constants.FujiHRP, constants.MainnetHRP, constants.LocalHRP)
	if !validHRPs.Contains(hrp) {
		return ids.ShortID{}, fmt.Errorf("invalid HRP: %s", hrp)
	}

	var shortID ids.ShortID
	copy(shortID[:], addrBytes)
	return shortID, nil
}

func strip0x(s string) string {
	if len(s) >= 2 && s[0] == '0' && (s[1] == 'x' || s[1] == 'X') {
		return s[2:]
	}
	return s
}

func getEnv(key, defaultVal string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultVal
}

func mustGetEnv(key string) string {
	val := os.Getenv(key)
	if val == "" {
		fmt.Fprintf(os.Stderr, "ERROR: Required environment variable not set: %s\n", key)
		os.Exit(1)
	}
	return val
}

func fatal(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "\nERROR: "+format+"\n", args...)
	os.Exit(1)
}
