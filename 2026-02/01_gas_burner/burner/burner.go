package burner

import (
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
)

// Deploy deploys a pre-compiled variant and returns the contract address.
func Deploy(auth *bind.TransactOpts, backend bind.ContractBackend, v Variant) (common.Address, *types.Transaction, error) {
	// minimal ABI just for deployment (no constructor args)
	parsed, _ := abi.JSON(strings.NewReader("[]"))
	addr, tx, _, err := bind.DeployContract(auth, parsed, common.FromHex(v.Bin), backend)
	return addr, tx, err
}

// Burn sends a raw transaction: 4-byte selector + abi.encode(uint256).
func Burn(auth *bind.TransactOpts, backend bind.ContractBackend, contractAddr common.Address, selector [4]byte, iterations uint64) (*types.Transaction, error) {
	data := make([]byte, 4+32)
	copy(data[:4], selector[:])
	new(big.Int).SetUint64(iterations).FillBytes(data[4:36])

	bc := bind.NewBoundContract(contractAddr, abi.ABI{}, backend, backend, backend)
	return bc.RawTransact(auth, data)
}
