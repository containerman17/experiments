package burner

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"golang.org/x/crypto/sha3"
)

// Bytecode template for the INVALID-opcode burner contract.
// The 4-byte selector lives at byte offset 56..59 (hex chars 112..119).
const (
	binPrefix = "6080604052348015600e575f5ffd5b50606680601a5f395ff3fe6080604052348015600e575f5ffd5b50600436106026575f3560e01c8063"
	binSuffix = "14602a575b5f5ffd5b602efe5b00fea2646970667358221220000000000000000000000000000000000000000000000000000000000000000064736f6c634300081c0033"
)

// Variant holds deployment bytecode and its burn function selector.
type Variant struct {
	Bin      string
	Selector [4]byte
}

// RandomVariant generates a unique contract variant with a random function selector.
func RandomVariant() Variant {
	var rb [8]byte
	rand.Read(rb[:])
	// random method name: letter + hex noise
	name := string('a'+(rb[0]%26)) + hex.EncodeToString(rb[1:])
	sig := name + "()"

	h := sha3.NewLegacyKeccak256()
	h.Write([]byte(sig))
	var sel [4]byte
	copy(sel[:], h.Sum(nil)[:4])

	bin := binPrefix + fmt.Sprintf("%02x%02x%02x%02x", sel[0], sel[1], sel[2], sel[3]) + binSuffix
	return Variant{Bin: bin, Selector: sel}
}

// Deploy deploys a variant and returns the contract address.
func Deploy(auth *bind.TransactOpts, backend bind.ContractBackend, v Variant) (common.Address, *types.Transaction, error) {
	parsed, _ := abi.JSON(strings.NewReader("[]"))
	addr, tx, _, err := bind.DeployContract(auth, parsed, common.FromHex(v.Bin), backend)
	return addr, tx, err
}

// Burn sends a transaction calling the no-arg burn method.
// The contract uses INVALID (0xFE) to consume all provided gas.
// auth.GasLimit MUST be set by the caller — eth_estimateGas will fail.
func Burn(auth *bind.TransactOpts, backend bind.ContractBackend, contractAddr common.Address, selector [4]byte) (*types.Transaction, error) {
	data := make([]byte, 4)
	copy(data[:4], selector[:])
	bc := bind.NewBoundContract(contractAddr, abi.ABI{}, backend, backend, backend)
	return bc.RawTransact(auth, data)
}
