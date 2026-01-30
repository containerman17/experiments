package main

import (
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"

	"github.com/ava-labs/avalanchego/ids"
	"github.com/ava-labs/avalanchego/staking"
	"github.com/ava-labs/avalanchego/utils/crypto/bls"
	"github.com/ava-labs/avalanchego/utils/crypto/bls/signer/localsigner"
	"github.com/ava-labs/avalanchego/vms/platformvm/signer"
)

type KeysInfo struct {
	NodeID         string `json:"nodeID"`
	BLSPublicKey   string `json:"blsPublicKey"`
	BLSProofOfPoss string `json:"blsProofOfPossession"`
	StakingDir     string `json:"stakingDir"`
	CertFile       string `json:"certFile"`
	KeyFile        string `json:"keyFile"`
	BLSKeyFile     string `json:"blsKeyFile"`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "Usage: genkeys <output-dir>")
		os.Exit(1)
	}

	outputDir := os.Args[1]
	if err := os.MkdirAll(outputDir, 0755); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to create output directory: %v\n", err)
		os.Exit(1)
	}

	certFile := filepath.Join(outputDir, "staker.crt")
	keyFile := filepath.Join(outputDir, "staker.key")
	blsKeyFile := filepath.Join(outputDir, "signer.key")

	// Check if files already exist - if so, load them instead of generating new ones
	if _, err := os.Stat(certFile); err == nil {
		// Files exist, load and output info
		info, err := loadExistingKeys(outputDir, certFile, keyFile, blsKeyFile)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Failed to load existing keys: %v\n", err)
			os.Exit(1)
		}
		infoJSON, _ := json.MarshalIndent(info, "", "  ")
		fmt.Println(string(infoJSON))
		return
	}

	// Generate TLS certificate and key (PEM encoded)
	certPEM, keyPEM, err := staking.NewCertAndKeyBytes()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to generate TLS cert: %v\n", err)
		os.Exit(1)
	}

	// Write TLS cert
	if err := os.WriteFile(certFile, certPEM, 0644); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to write cert: %v\n", err)
		os.Exit(1)
	}

	// Write TLS key
	if err := os.WriteFile(keyFile, keyPEM, 0600); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to write key: %v\n", err)
		os.Exit(1)
	}

	// Generate BLS signer key
	blsSigner, err := localsigner.New()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to generate BLS key: %v\n", err)
		os.Exit(1)
	}

	if err := blsSigner.ToFile(blsKeyFile); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to write BLS key: %v\n", err)
		os.Exit(1)
	}

	// Get node ID from certificate
	nodeID, err := getNodeIDFromCertPEM(certPEM)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to get node ID: %v\n", err)
		os.Exit(1)
	}

	// Generate proof of possession
	pop, err := signer.NewProofOfPossession(blsSigner)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to generate proof of possession: %v\n", err)
		os.Exit(1)
	}

	info := KeysInfo{
		NodeID:         nodeID.String(),
		BLSPublicKey:   hex.EncodeToString(pop.PublicKey[:]),
		BLSProofOfPoss: hex.EncodeToString(pop.ProofOfPossession[:]),
		StakingDir:     outputDir,
		CertFile:       certFile,
		KeyFile:        keyFile,
		BLSKeyFile:     blsKeyFile,
	}

	infoJSON, _ := json.MarshalIndent(info, "", "  ")
	fmt.Println(string(infoJSON))
}

func getNodeIDFromCertPEM(certPEM []byte) (ids.NodeID, error) {
	block, _ := pem.Decode(certPEM)
	if block == nil {
		return ids.EmptyNodeID, fmt.Errorf("failed to decode PEM cert")
	}

	x509Cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return ids.EmptyNodeID, fmt.Errorf("failed to parse certificate: %w", err)
	}

	stakingCert := &staking.Certificate{
		Raw:       x509Cert.Raw,
		PublicKey: x509Cert.PublicKey,
	}

	return ids.NodeIDFromCert(stakingCert), nil
}

func loadExistingKeys(outputDir, certFile, keyFile, blsKeyFile string) (*KeysInfo, error) {
	// Load cert to get node ID
	certPEM, err := os.ReadFile(certFile)
	if err != nil {
		return nil, fmt.Errorf("failed to read cert: %w", err)
	}

	nodeID, err := getNodeIDFromCertPEM(certPEM)
	if err != nil {
		return nil, err
	}

	// Load BLS key to get public key and generate PoP
	blsSigner, err := localsigner.FromFile(blsKeyFile)
	if err != nil {
		return nil, fmt.Errorf("failed to load BLS key: %w", err)
	}

	pop, err := signer.NewProofOfPossession(blsSigner)
	if err != nil {
		return nil, fmt.Errorf("failed to generate proof of possession: %w", err)
	}

	// Get public key bytes
	pkBytes := bls.PublicKeyToCompressedBytes(blsSigner.PublicKey())

	return &KeysInfo{
		NodeID:         nodeID.String(),
		BLSPublicKey:   hex.EncodeToString(pkBytes),
		BLSProofOfPoss: hex.EncodeToString(pop.ProofOfPossession[:]),
		StakingDir:     outputDir,
		CertFile:       certFile,
		KeyFile:        keyFile,
		BLSKeyFile:     blsKeyFile,
	}, nil
}
