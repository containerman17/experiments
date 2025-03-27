package contracts

import (
	"math/big"

	_ "embed"

	"golang.org/x/crypto/sha3"
)

func GetCPUPayloadData(intensity uint64) []byte {
	// Calculate the method ID using keccak256
	methodSig := []byte("consumeCPU(uint64)")
	hasher := sha3.NewLegacyKeccak256()
	hasher.Write(methodSig)
	methodID := hasher.Sum(nil)[:4]

	// Create a 32-byte array for the uint64 parameter
	paramBytes := make([]byte, 32)

	// Convert intensity to big-endian and put in the last 8 bytes of the 32-byte array
	intensityBig := new(big.Int).SetUint64(intensity)
	intensityBytes := intensityBig.Bytes()

	// Copy the intensity bytes to the end of the parameter buffer
	copy(paramBytes[32-len(intensityBytes):], intensityBytes)

	// Concatenate method ID and parameter
	return append(methodID, paramBytes...)
}
