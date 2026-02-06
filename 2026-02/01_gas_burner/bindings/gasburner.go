// Code generated - DO NOT EDIT.
// This file is a generated binding and any manual changes will be lost.

package bindings

import (
	"errors"
	"math/big"
	"strings"

	ethereum "github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/event"
)

// Reference imports to suppress errors if they are not otherwise used.
var (
	_ = errors.New
	_ = big.NewInt
	_ = strings.NewReader
	_ = ethereum.NotFound
	_ = bind.Bind
	_ = common.Big1
	_ = types.BloomLookup
	_ = event.NewSubscription
	_ = abi.ConvertType
)

// GasBurnerMetaData contains all meta data concerning the GasBurner contract.
var GasBurnerMetaData = &bind.MetaData{
	ABI: "[{\"inputs\":[{\"internalType\":\"uint256\",\"name\":\"iterations\",\"type\":\"uint256\"}],\"name\":\"burn\",\"outputs\":[],\"stateMutability\":\"nonpayable\",\"type\":\"function\"},{\"inputs\":[],\"name\":\"lastHash\",\"outputs\":[{\"internalType\":\"bytes32\",\"name\":\"\",\"type\":\"bytes32\"}],\"stateMutability\":\"view\",\"type\":\"function\"}]",
	Bin: "0x6080604052348015600e575f5ffd5b506101138061001c5f395ff3fe6080604052348015600e575f5ffd5b50600436106030575f3560e01c80633fa2180614603457806342966c6814604d575b5f5ffd5b603b5f5481565b60405190815260200160405180910390f35b605c605836600460c7565b605e565b005b5f81604051602001607191815260200190565b60408051601f19818403018152919052805160209091012090505f5b8281101560c15760408051602081018490520160408051601f1981840301815291905280516020909101209150600101608d565b505f5550565b5f6020828403121560d6575f5ffd5b503591905056fea2646970667358221220abfc54f797b20ee2c3ea45459f83743a5dc10e3ac594ef8cd6a8321447ddd8fb64736f6c634300081c0033",
}

// GasBurnerABI is the input ABI used to generate the binding from.
// Deprecated: Use GasBurnerMetaData.ABI instead.
var GasBurnerABI = GasBurnerMetaData.ABI

// GasBurnerBin is the compiled bytecode used for deploying new contracts.
// Deprecated: Use GasBurnerMetaData.Bin instead.
var GasBurnerBin = GasBurnerMetaData.Bin

// DeployGasBurner deploys a new Ethereum contract, binding an instance of GasBurner to it.
func DeployGasBurner(auth *bind.TransactOpts, backend bind.ContractBackend) (common.Address, *types.Transaction, *GasBurner, error) {
	parsed, err := GasBurnerMetaData.GetAbi()
	if err != nil {
		return common.Address{}, nil, nil, err
	}
	if parsed == nil {
		return common.Address{}, nil, nil, errors.New("GetABI returned nil")
	}

	address, tx, contract, err := bind.DeployContract(auth, *parsed, common.FromHex(GasBurnerBin), backend)
	if err != nil {
		return common.Address{}, nil, nil, err
	}
	return address, tx, &GasBurner{GasBurnerCaller: GasBurnerCaller{contract: contract}, GasBurnerTransactor: GasBurnerTransactor{contract: contract}, GasBurnerFilterer: GasBurnerFilterer{contract: contract}}, nil
}

// GasBurner is an auto generated Go binding around an Ethereum contract.
type GasBurner struct {
	GasBurnerCaller     // Read-only binding to the contract
	GasBurnerTransactor // Write-only binding to the contract
	GasBurnerFilterer   // Log filterer for contract events
}

// GasBurnerCaller is an auto generated read-only Go binding around an Ethereum contract.
type GasBurnerCaller struct {
	contract *bind.BoundContract // Generic contract wrapper for the low level calls
}

// GasBurnerTransactor is an auto generated write-only Go binding around an Ethereum contract.
type GasBurnerTransactor struct {
	contract *bind.BoundContract // Generic contract wrapper for the low level calls
}

// GasBurnerFilterer is an auto generated log filtering Go binding around an Ethereum contract events.
type GasBurnerFilterer struct {
	contract *bind.BoundContract // Generic contract wrapper for the low level calls
}

// GasBurnerSession is an auto generated Go binding around an Ethereum contract,
// with pre-set call and transact options.
type GasBurnerSession struct {
	Contract     *GasBurner        // Generic contract binding to set the session for
	CallOpts     bind.CallOpts     // Call options to use throughout this session
	TransactOpts bind.TransactOpts // Transaction auth options to use throughout this session
}

// GasBurnerCallerSession is an auto generated read-only Go binding around an Ethereum contract,
// with pre-set call options.
type GasBurnerCallerSession struct {
	Contract *GasBurnerCaller // Generic contract caller binding to set the session for
	CallOpts bind.CallOpts    // Call options to use throughout this session
}

// GasBurnerTransactorSession is an auto generated write-only Go binding around an Ethereum contract,
// with pre-set transact options.
type GasBurnerTransactorSession struct {
	Contract     *GasBurnerTransactor // Generic contract transactor binding to set the session for
	TransactOpts bind.TransactOpts    // Transaction auth options to use throughout this session
}

// GasBurnerRaw is an auto generated low-level Go binding around an Ethereum contract.
type GasBurnerRaw struct {
	Contract *GasBurner // Generic contract binding to access the raw methods on
}

// GasBurnerCallerRaw is an auto generated low-level read-only Go binding around an Ethereum contract.
type GasBurnerCallerRaw struct {
	Contract *GasBurnerCaller // Generic read-only contract binding to access the raw methods on
}

// GasBurnerTransactorRaw is an auto generated low-level write-only Go binding around an Ethereum contract.
type GasBurnerTransactorRaw struct {
	Contract *GasBurnerTransactor // Generic write-only contract binding to access the raw methods on
}

// NewGasBurner creates a new instance of GasBurner, bound to a specific deployed contract.
func NewGasBurner(address common.Address, backend bind.ContractBackend) (*GasBurner, error) {
	contract, err := bindGasBurner(address, backend, backend, backend)
	if err != nil {
		return nil, err
	}
	return &GasBurner{GasBurnerCaller: GasBurnerCaller{contract: contract}, GasBurnerTransactor: GasBurnerTransactor{contract: contract}, GasBurnerFilterer: GasBurnerFilterer{contract: contract}}, nil
}

// NewGasBurnerCaller creates a new read-only instance of GasBurner, bound to a specific deployed contract.
func NewGasBurnerCaller(address common.Address, caller bind.ContractCaller) (*GasBurnerCaller, error) {
	contract, err := bindGasBurner(address, caller, nil, nil)
	if err != nil {
		return nil, err
	}
	return &GasBurnerCaller{contract: contract}, nil
}

// NewGasBurnerTransactor creates a new write-only instance of GasBurner, bound to a specific deployed contract.
func NewGasBurnerTransactor(address common.Address, transactor bind.ContractTransactor) (*GasBurnerTransactor, error) {
	contract, err := bindGasBurner(address, nil, transactor, nil)
	if err != nil {
		return nil, err
	}
	return &GasBurnerTransactor{contract: contract}, nil
}

// NewGasBurnerFilterer creates a new log filterer instance of GasBurner, bound to a specific deployed contract.
func NewGasBurnerFilterer(address common.Address, filterer bind.ContractFilterer) (*GasBurnerFilterer, error) {
	contract, err := bindGasBurner(address, nil, nil, filterer)
	if err != nil {
		return nil, err
	}
	return &GasBurnerFilterer{contract: contract}, nil
}

// bindGasBurner binds a generic wrapper to an already deployed contract.
func bindGasBurner(address common.Address, caller bind.ContractCaller, transactor bind.ContractTransactor, filterer bind.ContractFilterer) (*bind.BoundContract, error) {
	parsed, err := GasBurnerMetaData.GetAbi()
	if err != nil {
		return nil, err
	}
	return bind.NewBoundContract(address, *parsed, caller, transactor, filterer), nil
}

// Call invokes the (constant) contract method with params as input values and
// sets the output to result. The result type might be a single field for simple
// returns, a slice of interfaces for anonymous returns and a struct for named
// returns.
func (_GasBurner *GasBurnerRaw) Call(opts *bind.CallOpts, result *[]interface{}, method string, params ...interface{}) error {
	return _GasBurner.Contract.GasBurnerCaller.contract.Call(opts, result, method, params...)
}

// Transfer initiates a plain transaction to move funds to the contract, calling
// its default method if one is available.
func (_GasBurner *GasBurnerRaw) Transfer(opts *bind.TransactOpts) (*types.Transaction, error) {
	return _GasBurner.Contract.GasBurnerTransactor.contract.Transfer(opts)
}

// Transact invokes the (paid) contract method with params as input values.
func (_GasBurner *GasBurnerRaw) Transact(opts *bind.TransactOpts, method string, params ...interface{}) (*types.Transaction, error) {
	return _GasBurner.Contract.GasBurnerTransactor.contract.Transact(opts, method, params...)
}

// Call invokes the (constant) contract method with params as input values and
// sets the output to result. The result type might be a single field for simple
// returns, a slice of interfaces for anonymous returns and a struct for named
// returns.
func (_GasBurner *GasBurnerCallerRaw) Call(opts *bind.CallOpts, result *[]interface{}, method string, params ...interface{}) error {
	return _GasBurner.Contract.contract.Call(opts, result, method, params...)
}

// Transfer initiates a plain transaction to move funds to the contract, calling
// its default method if one is available.
func (_GasBurner *GasBurnerTransactorRaw) Transfer(opts *bind.TransactOpts) (*types.Transaction, error) {
	return _GasBurner.Contract.contract.Transfer(opts)
}

// Transact invokes the (paid) contract method with params as input values.
func (_GasBurner *GasBurnerTransactorRaw) Transact(opts *bind.TransactOpts, method string, params ...interface{}) (*types.Transaction, error) {
	return _GasBurner.Contract.contract.Transact(opts, method, params...)
}

// LastHash is a free data retrieval call binding the contract method 0x3fa21806.
//
// Solidity: function lastHash() view returns(bytes32)
func (_GasBurner *GasBurnerCaller) LastHash(opts *bind.CallOpts) ([32]byte, error) {
	var out []interface{}
	err := _GasBurner.contract.Call(opts, &out, "lastHash")

	if err != nil {
		return *new([32]byte), err
	}

	out0 := *abi.ConvertType(out[0], new([32]byte)).(*[32]byte)

	return out0, err

}

// LastHash is a free data retrieval call binding the contract method 0x3fa21806.
//
// Solidity: function lastHash() view returns(bytes32)
func (_GasBurner *GasBurnerSession) LastHash() ([32]byte, error) {
	return _GasBurner.Contract.LastHash(&_GasBurner.CallOpts)
}

// LastHash is a free data retrieval call binding the contract method 0x3fa21806.
//
// Solidity: function lastHash() view returns(bytes32)
func (_GasBurner *GasBurnerCallerSession) LastHash() ([32]byte, error) {
	return _GasBurner.Contract.LastHash(&_GasBurner.CallOpts)
}

// Burn is a paid mutator transaction binding the contract method 0x42966c68.
//
// Solidity: function burn(uint256 iterations) returns()
func (_GasBurner *GasBurnerTransactor) Burn(opts *bind.TransactOpts, iterations *big.Int) (*types.Transaction, error) {
	return _GasBurner.contract.Transact(opts, "burn", iterations)
}

// Burn is a paid mutator transaction binding the contract method 0x42966c68.
//
// Solidity: function burn(uint256 iterations) returns()
func (_GasBurner *GasBurnerSession) Burn(iterations *big.Int) (*types.Transaction, error) {
	return _GasBurner.Contract.Burn(&_GasBurner.TransactOpts, iterations)
}

// Burn is a paid mutator transaction binding the contract method 0x42966c68.
//
// Solidity: function burn(uint256 iterations) returns()
func (_GasBurner *GasBurnerTransactorSession) Burn(iterations *big.Int) (*types.Transaction, error) {
	return _GasBurner.Contract.Burn(&_GasBurner.TransactOpts, iterations)
}
